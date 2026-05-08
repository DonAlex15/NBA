// One-time script: fetch birthdates for all NBA players from Wikidata + ESPN
// Run: node scripts/fetch-birthdates.js
// Output: playerMeta.json (name → birthdate string "YYYY-MM-DD")

const https = require('https');
const fs = require('fs');
const path = require('path');

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const req = https.request({
      hostname: opts.hostname,
      path: opts.pathname + opts.search,
      headers: { 'User-Agent': 'nba-stats-app/1.0', ...headers },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`JSON parse failed: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── 1. Wikidata: all NBA players with birthdates ──────────────────────────────
async function fetchWikidata() {
  const sparql = `
    SELECT DISTINCT ?playerLabel ?dob WHERE {
      ?player wdt:P31 wd:Q5 ;
              wdt:P569 ?dob ;
              wdt:P54  ?team .
      ?team   wdt:P118 wd:Q155223 .
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
  `.trim();

  const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(sparql);
  console.log('Fetching Wikidata NBA players...');
  const data = await get(url, { Accept: 'application/sparql-results+json' });

  const results = {};
  for (const row of data.results.bindings) {
    const name = row.playerLabel?.value;
    const dob  = row.dob?.value?.slice(0, 10); // "YYYY-MM-DD"
    if (name && dob && dob > '1900-01-01') {
      results[name] = dob;
    }
  }
  console.log(`Wikidata: ${Object.keys(results).length} players`);
  return results;
}

// ── 2. ESPN: active/recent players (already has dateOfBirth) ──────────────────
async function fetchESPN() {
  const results = {};

  // Get all athlete $refs
  const refs = [];
  let page = 1;
  while (true) {
    const url = `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/athletes?limit=1000&page=${page}`;
    const data = await get(url);
    const items = data.items || [];
    refs.push(...items.map(i => i.$ref));
    if (refs.length >= data.count || items.length === 0) break;
    page++;
  }
  console.log(`ESPN: ${refs.length} athlete refs found`);

  // Batch fetch athlete details
  const ids = refs.map(r => { const m = r.match(/\/athletes\/(\d+)/); return m?.[1]; }).filter(Boolean);
  const BATCH = 50;
  let done = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    await Promise.all(batch.map(id =>
      get(`https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/athletes/${id}`)
        .then(d => {
          const name = d.fullName || d.displayName;
          const dob  = d.dateOfBirth?.slice(0, 10);
          if (name && dob) results[name] = dob;
        })
        .catch(() => {})
    ));
    done += batch.length;
    process.stdout.write(`\rESPN: fetched ${done}/${ids.length}`);
  }
  console.log(`\nESPN: ${Object.keys(results).length} players with birthdates`);
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const [wikidata, espn] = await Promise.all([fetchWikidata(), fetchESPN()]);

    // Merge: ESPN takes priority (more precise dates), Wikidata fills gaps
    const merged = { ...wikidata, ...espn };

    // Sort by name for readability
    const sorted = Object.fromEntries(
      Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))
    );

    const outPath = path.join(__dirname, '..', 'playerMeta.json');
    fs.writeFileSync(outPath, JSON.stringify(sorted, null, 2));
    console.log(`\nWrote ${Object.keys(sorted).length} players to playerMeta.json`);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
