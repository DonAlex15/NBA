const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

// Player birthdate lookup: { "LeBron James": "1984-12-30", ... }
const PLAYER_META = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'playerMeta.json'), 'utf8')); }
  catch { return {}; }
})();

// Pre-fetched career stats for the historical (Basketball-Reference) legends.
// Their careers never change, so they're stored to disk to avoid scraping BBRef.
// Regenerate with `node fetchLegends.js`. Missing entries fall back to live scrape.
const LEGENDS_STORE = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'legends.json'), 'utf8')); }
  catch { return {}; }
})();

// Age as of Feb 1 of the season (NBA convention: e.g. "2003-04" → Feb 1 2004)
function ageForSeason(season, birthDate) {
  if (!birthDate) return null;
  const startYear = parseInt(season.split('-')[0]);
  const feb1 = new Date(startYear + 1, 1, 1);
  const birth = new Date(birthDate);
  const age = feb1.getFullYear() - birth.getFullYear();
  const hadBirthday = feb1 >= new Date(feb1.getFullYear(), birth.getMonth(), birth.getDate());
  return hadBirthday ? age : age - 1;
}

const app = express();
const PORT = process.env.PORT || 3000;

const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() < hit.exp) return Promise.resolve(hit.data);
  return fn().then(data => { cache.set(key, { data, exp: Date.now() + ttlMs }); return data; });
}

function currentSeason() {
  const now = new Date();
  const y = now.getFullYear();
  return (now.getMonth() + 1) >= 10 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

// "2024-25" → 2025  (ESPN stats use the ending year of the season)
function seasonToEspnStatsYear(season) {
  const parts = season.split('-');
  return parseInt(parts[0]) + 1;
}

// "2024-25" → 2024  (ESPN standings use the starting year)
function seasonToEspnStandingsYear(season) {
  return parseInt(season.split('-')[0]);
}

function espnGet(url, params = {}) {
  return axios.get(url, { params, timeout: 20000 });
}

// Parse ESPN stats categories array into a flat name→value map
function parseEspnStats(categories) {
  const m = {};
  for (const cat of (categories || [])) {
    for (const s of (cat.stats || [])) m[s.name] = s.value;
  }
  return m;
}

// Well-known retired legends not in ESPN's active 843-player listing
const NBA_LEGENDS = [
  { id: '37',  name: 'Charles Barkley',   team: '', debutYear: 1984 },
  { id: '110', name: 'Kobe Bryant',        team: '', debutYear: 1996 },
  { id: '215', name: 'Tim Duncan',         team: '', debutYear: 1997 },
  { id: '261', name: 'Kevin Garnett',      team: '', debutYear: 1995 },
  { id: '272', name: 'Manu Ginobili',      team: '', debutYear: 2002 },
  { id: '366', name: 'Allen Iverson',      team: '', debutYear: 1996 },
  { id: '1035', name: 'Michael Jordan',    team: '', debutYear: 1984 },
  { id: '501', name: 'Karl Malone',        team: '', debutYear: 1985 },
  { id: '592', name: 'Steve Nash',         team: '', debutYear: 1996 },
  { id: '609', name: 'Dirk Nowitzki',      team: '', debutYear: 1998 },
  { id: '614', name: "Shaquille O'Neal",   team: '', debutYear: 1992 },
  { id: '640', name: 'Gary Payton',        team: '', debutYear: 1990 },
];

// Historical greats whose full careers predate ESPN's data (ESPN has no NBA
// data before ~1976). These are sourced from Basketball-Reference instead.
// id is prefixed "bbr_" so the career endpoint routes them to the BBRef parser.
const BBREF_LEGENDS = [
  { id: 'bbr_abdulka01', name: 'Kareem Abdul-Jabbar' },
  { id: 'bbr_chambwi01', name: 'Wilt Chamberlain' },
  { id: 'bbr_russebi01', name: 'Bill Russell' },
  { id: 'bbr_roberos01', name: 'Oscar Robertson' },
  { id: 'bbr_westje01',  name: 'Jerry West' },
  { id: 'bbr_johnsma02', name: 'Magic Johnson' },
  { id: 'bbr_birdla01',  name: 'Larry Bird' },
  { id: 'bbr_ervinju01', name: 'Julius Erving' },
  { id: 'bbr_bayloel01', name: 'Elgin Baylor' },
  { id: 'bbr_havlijo01', name: 'John Havlicek' },
  { id: 'bbr_malonmo01', name: 'Moses Malone' },
  { id: 'bbr_barryri01', name: 'Rick Barry' },
  { id: 'bbr_gervige01', name: 'George Gervin' },
  { id: 'bbr_thomais01', name: 'Isiah Thomas' },
  { id: 'bbr_olajuha01', name: 'Hakeem Olajuwon' },
];

// Basketball-Reference uses a few team abbreviations that differ from the
// scheme used by CHAMPIONS/MVPS in index.html. Map those to the app's scheme.
const BBREF_TEAM_FIX = { PHO: 'PHX', WSB: 'WAS', CHH: 'CHA', NJN: 'BKN', SDC: 'LAC', NOH: 'NOP', KCK: 'SAC' };

// Seasons to drop, keyed by BBRef id. Baylor retired 9 games into 1971-72
// before the Lakers won the title, so that row falsely earns a championship.
const BBREF_EXCLUDE = { bayloel01: new Set(['1971-72']) };

async function buildBbrefCareer(bbrefId) {
  const letter = bbrefId[0];
  const r = await axios.get(
    `https://www.basketball-reference.com/players/${letter}/${bbrefId}.html`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' }, timeout: 20000 }
  );
  // BBRef hides some tables inside HTML comments; unwrap them before matching.
  const html = String(r.data).replace(/<!--/g, '').replace(/-->/g, '');
  const tblMatch = html.match(/<table[^>]*id="per_game_stats"[\s\S]*?<\/table>/)
                || html.match(/<table[^>]*id="per_game"[\s\S]*?<\/table>/);
  if (!tblMatch) return [];
  const bodyMatch = tblMatch[0].match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!bodyMatch) return [];

  const cell = (row, stat) => {
    const m = row.match(new RegExp('data-stat="' + stat + '"[^>]*>([\\s\\S]*?)</(?:td|th)>'));
    if (!m) return '';
    return m[1].replace(/<[^>]+>/g, '').trim();
  };
  const num = (row, stat) => { const v = parseFloat(cell(row, stat)); return Number.isNaN(v) ? 0 : v; };

  // Group rows by season so multi-team ("2TM"/"3TM") seasons collapse to one.
  const bySeason = {};
  for (const rm of bodyMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const row = rm[1];
    const season = cell(row, 'year_id');
    if (!/^\d{4}-\d{2}$/.test(season)) continue;
    const teamRaw = cell(row, 'team_name_abbr') || cell(row, 'team_id');
    const isCombined = /^\d+TM$/.test(teamRaw) || teamRaw === 'TOT';
    (bySeason[season] = bySeason[season] || []).push({ row, teamRaw, isCombined, gp: num(row, 'games') });
  }

  const excluded = BBREF_EXCLUDE[bbrefId];
  const seasons = [];
  for (const season of Object.keys(bySeason)) {
    if (excluded && excluded.has(season)) continue;
    const parts = bySeason[season];
    // Season-average stats come from the combined row if present, else the sole row.
    const statRow = (parts.find(p => p.isCombined) || parts[0]).row;
    // Team for display/championship uses the single team with the most games.
    const teamParts = parts.filter(p => !p.isCombined);
    const teamPick = (teamParts.length ? teamParts : parts).sort((a, b) => b.gp - a.gp)[0];
    const teamRaw = teamPick.teamRaw;
    const team = BBREF_TEAM_FIX[teamRaw] || teamRaw;
    seasons.push({
      season,
      team,
      team_id: null,
      age:     parseInt(cell(statRow, 'age'), 10) || null,
      gp:      num(statRow, 'games'),
      gs:      num(statRow, 'games_started'),
      min:     +num(statRow, 'mp_per_g').toFixed(1),
      pts:     +num(statRow, 'pts_per_g').toFixed(1),
      reb:     +num(statRow, 'trb_per_g').toFixed(1),
      oreb:    +num(statRow, 'orb_per_g').toFixed(1),
      dreb:    +num(statRow, 'drb_per_g').toFixed(1),
      ast:     +num(statRow, 'ast_per_g').toFixed(1),
      stl:     +num(statRow, 'stl_per_g').toFixed(1),
      blk:     +num(statRow, 'blk_per_g').toFixed(1),
      tov:     +num(statRow, 'tov_per_g').toFixed(1),
      pf:      +num(statRow, 'pf_per_g').toFixed(1),
      fgm:     +num(statRow, 'fg_per_g').toFixed(1),
      fga:     +num(statRow, 'fga_per_g').toFixed(1),
      fg_pct:  +num(statRow, 'fg_pct').toFixed(3),
      fg3m:    +num(statRow, 'fg3_per_g').toFixed(1),
      fg3a:    +num(statRow, 'fg3a_per_g').toFixed(1),
      fg3_pct: +num(statRow, 'fg3_pct').toFixed(3),
      ftm:     +num(statRow, 'ft_per_g').toFixed(1),
      fta:     +num(statRow, 'fta_per_g').toFixed(1),
      ft_pct:  +num(statRow, 'ft_pct').toFixed(3),
    });
  }
  return seasons.sort((a, b) => a.season.localeCompare(b.season));
}

// Build full player list from ESPN athlete listing (runs once, cached 24h)
async function buildPlayerList() {
  console.log('Building player cache from ESPN...');
  const refs = [];
  let page = 1;
  while (true) {
    const r = await espnGet(
      'https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/athletes',
      { limit: 1000, page }
    );
    const items = r.data.items || [];
    refs.push(...items.map(i => i.$ref));
    if (refs.length >= r.data.count || items.length === 0) break;
    page++;
  }

  // Extract IDs directly from $ref URLs to avoid 843 extra requests
  // e.g. ".../athletes/1966?..." → "1966"
  const athletes = refs.map(ref => {
    const m = ref.match(/\/athletes\/(\d+)/);
    return m ? m[1] : null;
  }).filter(Boolean);

  // Batch-fetch athlete details (name + debutYear)
  const players = [];
  const BATCH = 50;
  for (let i = 0; i < athletes.length; i += BATCH) {
    const batch = athletes.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(id =>
        espnGet(`https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/athletes/${id}`)
          .then(r => ({
            id: r.data.id,
            name: r.data.fullName || r.data.displayName || '',
            team: '',
            debutYear: r.data.debutYear || null,
          }))
          .catch(() => null)
      )
    );
    players.push(...results.filter(Boolean));
  }

  // Merge legends (avoid duplicates by id)
  const ids = new Set(players.map(p => p.id));
  for (const legend of NBA_LEGENDS) {
    if (!ids.has(legend.id)) players.push(legend);
  }
  // BBRef historical greats (keyed by name to avoid ESPN duplicates)
  const names = new Set(players.map(p => p.name.toLowerCase()));
  for (const legend of BBREF_LEGENDS) {
    if (!names.has(legend.name.toLowerCase())) {
      players.push({ id: legend.id, name: legend.name, team: '', debutYear: null });
    }
  }

  console.log(`Player cache built: ${players.length} players`);
  return players;
}

// ESPN teamId → abbreviation, matching the scheme used in CHAMPIONS (index.html)
const ESPN_TEAM_ABBR = {
  '1':'ATL','2':'BOS','3':'NOP','4':'CHI','5':'CLE','6':'DAL','7':'DEN','8':'DET',
  '9':'GSW','10':'HOU','11':'IND','12':'LAC','13':'LAL','14':'MIA','15':'MIL',
  '16':'MIN','17':'BKN','18':'NYK','19':'ORL','20':'PHI','21':'PHX','22':'POR',
  '23':'SAC','24':'SAS','25':'OKC','26':'UTA','27':'WAS','28':'TOR','29':'MEM','30':'CHA',
};

// One request per player: { espnYear: teamAbbr } from ESPN's consolidated stats.
// The per-season statistics endpoint omits team, so championship detection needs this.
async function fetchTeamByYear(espnId) {
  try {
    const r = await espnGet(`https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${espnId}/stats`);
    const avg = (r.data.categories || []).find(c => c.name === 'averages');
    const gpIdx = (avg?.names || []).indexOf('gamesPlayed');
    const byYear = {};
    for (const st of (avg?.statistics || [])) {
      const year = st.season?.year;
      const abbr = ESPN_TEAM_ABBR[String(st.teamId)];
      if (!year || !abbr) continue;
      const gp = gpIdx >= 0 ? (parseFloat(st.stats?.[gpIdx]) || 0) : 0;
      // For traded seasons keep the team where the player played the most games
      if (!byYear[year] || gp > byYear[year].gp) byYear[year] = { abbr, gp };
    }
    const out = {};
    for (const y in byYear) out[y] = byYear[y].abbr;
    return out;
  } catch { return {}; }
}

// Live ESPN search — catches retired players absent from the active-athletes
// listing (e.g. Steve Francis, Tracy McGrady). uid "s:40~l:46~a:255": l:46 = NBA.
async function espnSearchPlayers(q) {
  try {
    const r = await espnGet('https://site.web.api.espn.com/apis/search/v2', { query: q, limit: 20 });
    const out = [];
    const seen = new Set();
    for (const group of (r.data.results || [])) {
      if (group.type !== 'player') continue;
      for (const c of (group.contents || [])) {
        if (c.sport !== 'basketball') continue;
        const m = /~l:46~a:(\d+)/.exec(c.uid || '');   // NBA league only
        if (!m) continue;
        const id = m[1];
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, name: c.displayName || '', team: '', debutYear: null });
      }
    }
    return out;
  } catch { return []; }
}

// Fetch a single athlete's name + debut year (for retired players found via search)
async function fetchAthleteMeta(espnId) {
  try {
    const r = await espnGet(`https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/athletes/${espnId}`);
    return { id: String(r.data.id), name: r.data.fullName || r.data.displayName || '', debutYear: r.data.debutYear || null };
  } catch { return null; }
}

// Fetch career season-by-season stats from ESPN
async function buildCareerStats(espnId, debutYear, playerName) {
  const birthDate = playerName ? PLAYER_META[playerName] : null;
  const teamByYear = await fetchTeamByYear(espnId);
  const curEspnYear = seasonToEspnStatsYear(currentSeason());
  // ESPN stats year = ending year of season; debutYear 2003 → first ESPN year = 2004
  const startYear = debutYear ? debutYear + 1 : 2002;
  const years = [];
  for (let y = startYear; y <= curEspnYear; y++) years.push(y);

  const BATCH = 5;
  const seasons = [];
  for (let i = 0; i < years.length; i += BATCH) {
    const batch = years.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(year =>
        espnGet(
          `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/${year}/types/2/athletes/${espnId}/statistics/0`
        )
          .then(r => {
            const m = parseEspnStats(r.data.splits?.categories);
            const gp = m.gamesPlayed || 0;
            if (!gp) return null;
            const seasonStr = `${year - 1}-${String(year).slice(2)}`;
            return {
              season:   seasonStr,
              team:     teamByYear[year] || '',
              team_id:  null,
              age:      ageForSeason(seasonStr, birthDate),
              gp,
              gs:       m.gamesStarted                       || 0,
              min:      +(m.avgMinutes                       || 0).toFixed(1),
              pts:      +(m.avgPoints                        || 0).toFixed(1),
              reb:      +(m.avgRebounds                      || 0).toFixed(1),
              oreb:     +(m.avgOffensiveRebounds              || 0).toFixed(1),
              dreb:     +(m.avgDefensiveRebounds              || 0).toFixed(1),
              ast:      +(m.avgAssists                       || 0).toFixed(1),
              stl:      +(m.avgSteals                        || 0).toFixed(1),
              blk:      +(m.avgBlocks                        || 0).toFixed(1),
              tov:      +(m.avgTurnovers                     || 0).toFixed(1),
              pf:       +(m.avgFouls                         || 0).toFixed(1),
              fgm:      +(m.avgFieldGoalsMade                || 0).toFixed(1),
              fga:      +(m.avgFieldGoalsAttempted           || 0).toFixed(1),
              fg_pct:   +(m.fieldGoalPct                     || 0).toFixed(3),
              fg3m:     +(m.avgThreePointFieldGoalsMade      || 0).toFixed(1),
              fg3a:     +(m.avgThreePointFieldGoalsAttempted || 0).toFixed(1),
              fg3_pct:  +(m.threePointFieldGoalPct           || 0).toFixed(3),
              ftm:      +(m.avgFreeThrowsMade                || 0).toFixed(1),
              fta:      +(m.avgFreeThrowsAttempted           || 0).toFixed(1),
              ft_pct:   +(m.freeThrowPct                     || 0).toFixed(3),
            };
          })
          .catch(() => null)
      )
    );
    seasons.push(...results.filter(Boolean));
  }

  seasons.sort((a, b) => a.season.localeCompare(b.season));

  // Fill in-career gaps (e.g. retirement years) as blank rows so every
  // season/age between the first and last played year is represented.
  if (seasons.length > 1) {
    const playedYears = new Set(seasons.map(s => Number(s.season.slice(0, 4)) + 1));
    const firstYear = Math.min(...playedYears);
    const lastYear  = Math.max(...playedYears);
    for (let year = firstYear; year <= lastYear; year++) {
      if (playedYears.has(year)) continue;
      const seasonStr = `${year - 1}-${String(year).slice(2)}`;
      seasons.push({
        season:  seasonStr,
        team:    '',
        team_id: null,
        age:     ageForSeason(seasonStr, birthDate),
        gp: null, gs: null, min: null, pts: null, reb: null, oreb: null,
        dreb: null, ast: null, stl: null, blk: null, tov: null, pf: null,
        fgm: null, fga: null, fg_pct: null, fg3m: null, fg3a: null,
        fg3_pct: null, ftm: null, fta: null, ft_pct: null,
      });
    }
    seasons.sort((a, b) => a.season.localeCompare(b.season));
  }

  return seasons;
}

// Serve UI
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Search NBA players
app.get('/api/players', async (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  try {
    const players = await cached('all-players', 24 * 3600 * 1000, buildPlayerList);
    const filtered = players.filter(p => p.name.toLowerCase().includes(q));
    // Rank: last name starts with query > full name starts with query > contains query
    const rank = name => {
      const n = name.toLowerCase();
      const parts = n.split(' ');
      if (parts[parts.length - 1].startsWith(q)) return 0;
      if (n.startsWith(q)) return 1;
      return 2;
    };
    filtered.sort((a, b) => rank(a.name) - rank(b.name));

    // If the local list is thin, ask ESPN's search API for retired/non-legend
    // players (e.g. Steve Francis, Tracy McGrady) and append any new hits.
    const combined = filtered.slice();
    if (combined.length < 10) {
      const seenIds = new Set(combined.map(p => p.id));
      const seenNames = new Set(combined.map(p => p.name.toLowerCase()));
      const extra = await cached(`espn-search-${q}`, 24 * 3600 * 1000, () => espnSearchPlayers(q));
      for (const p of extra) {
        if (seenIds.has(p.id) || seenNames.has(p.name.toLowerCase())) continue;
        seenIds.add(p.id);
        seenNames.add(p.name.toLowerCase());
        combined.push(p);
      }
    }
    res.json(combined.slice(0, 10));
  } catch (e) {
    console.error('Players error:', e.message);
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});

// Career season-by-season stats
app.get('/api/career/:playerId', async (req, res) => {
  const { playerId } = req.params;
  try {
    const seasons = playerId.startsWith('bbr_')
      ? (LEGENDS_STORE[playerId]
          || await cached(`career-${playerId}`, 24 * 3600 * 1000, () => buildBbrefCareer(playerId.slice(4))))
      : await cached(`career-${playerId}`, 24 * 3600 * 1000, async () => {
          const players = await cached('all-players', 24 * 3600 * 1000, buildPlayerList);
          let player = players.find(p => p.id === playerId);
          // ESPN-searched players aren't in the cached list, so fetch their
          // athlete meta on demand to get the debut year (full career span).
          if (!player) player = await fetchAthleteMeta(playerId);
          return buildCareerStats(playerId, player?.debutYear || null, player?.name);
        });
    res.json(seasons);
  } catch (e) {
    console.error('Career error:', e.message);
    res.status(500).json({ error: 'Failed to fetch career stats' });
  }
});

// Current-season PPG quick lookup
app.get('/api/ppg/:playerId', async (req, res) => {
  const { playerId } = req.params;
  const season = currentSeason();
  try {
    const stats = await cached(`ppg-${playerId}-${season}`, 3600 * 1000, async () => {
      const year = seasonToEspnStatsYear(season);
      const r = await espnGet(
        `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/${year}/types/2/athletes/${playerId}/statistics/0`
      );
      const m = parseEspnStats(r.data.splits?.categories);
      return m.gamesPlayed ? { gp: m.gamesPlayed, pts: +(m.avgPoints || 0).toFixed(1) } : null;
    });
    res.json(stats);
  } catch {
    res.json(null);
  }
});

// Team win% map for a season: { "espnTeamId": 0.671, ... }
app.get('/api/standings/:season', async (req, res) => {
  const { season } = req.params;
  const ttl = season === currentSeason() ? 3600 * 1000 : 7 * 24 * 3600 * 1000;
  try {
    const data = await cached(`standings-${season}`, ttl, async () => {
      const espnSeason = seasonToEspnStandingsYear(season);
      const r = await espnGet(
        'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings',
        { season: espnSeason }
      );
      const map = {};
      for (const conf of (r.data.children || [])) {
        for (const entry of (conf.standings?.entries || [])) {
          const teamId = entry.team?.id;
          const wpStat = (entry.stats || []).find(s => s.name === 'leagueWinPercent');
          if (teamId && wpStat) map[teamId] = wpStat.value;
        }
      }
      return map;
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch standings' });
  }
});

// ============= MLB Baseball API =============

app.get('/api/mlb/players', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try {
    const r = await axios.get('https://statsapi.mlb.com/api/v1/people/search', {
      params: { names: q, sportId: 1 },
      timeout: 10000,
    });
    const people = r.data.people || [];
    res.json(people.slice(0, 10).map(p => ({
      id: p.id,
      name: p.fullName,
      position: p.primaryPosition?.abbreviation || '',
      active: p.active,
    })));
  } catch (e) {
    res.status(500).json({ error: 'Failed to search MLB players' });
  }
});

app.get('/api/mlb/career/hitting/:playerId', async (req, res) => {
  const { playerId } = req.params;
  try {
    const data = await cached(`mlb-hit-${playerId}`, 24 * 3600 * 1000, async () => {
      const [statsR, infoR] = await Promise.all([
        axios.get(`https://statsapi.mlb.com/api/v1/people/${playerId}/stats`, {
          params: { stats: 'yearByYear', group: 'hitting', sportId: 1 },
          timeout: 15000,
        }),
        axios.get(`https://statsapi.mlb.com/api/v1/people/${playerId}`, {
          params: { fields: 'people,birthDate,primaryPosition' },
          timeout: 10000,
        }),
      ]);
      const person = infoR.data.people?.[0] || {};
      const birthYear = person.birthDate ? new Date(person.birthDate).getFullYear() : null;
      const position = person.primaryPosition?.abbreviation || '';
      const splits = statsR.data.stats?.[0]?.splits || [];
      const byYear = {};
      for (const s of splits) {
        const yr = s.season;
        const ab = +(s.stat?.atBats) || 0;
        if (!byYear[yr] || ab > (+(byYear[yr].stat?.atBats) || 0)) byYear[yr] = s;
      }
      return {
        birthYear, position,
        seasons: Object.values(byYear).sort((a, b) => a.season.localeCompare(b.season)).map(s => ({
          season:  s.season,
          team_id: s.team?.id || null,
          age:     birthYear ? parseInt(s.season) - birthYear : null,
          gp:      +(s.stat?.gamesPlayed) || 0,
          ab:      +(s.stat?.atBats) || 0,
          hits:    +(s.stat?.hits) || 0,
          hr:      +(s.stat?.homeRuns) || 0,
          rbi:     +(s.stat?.rbi) || 0,
          avg:     s.stat?.avg || '0',
          obp:     s.stat?.obp || '0',
          slg:     s.stat?.slg || '0',
          ops:     s.stat?.ops || '0',
          sb:      +(s.stat?.stolenBases) || 0,
        })),
      };
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch MLB hitting stats' });
  }
});

app.get('/api/mlb/career/pitching/:playerId', async (req, res) => {
  const { playerId } = req.params;
  try {
    const data = await cached(`mlb-pitch-${playerId}`, 24 * 3600 * 1000, async () => {
      const [statsR, infoR] = await Promise.all([
        axios.get(`https://statsapi.mlb.com/api/v1/people/${playerId}/stats`, {
          params: { stats: 'yearByYear', group: 'pitching', sportId: 1 },
          timeout: 15000,
        }),
        axios.get(`https://statsapi.mlb.com/api/v1/people/${playerId}`, {
          params: { fields: 'people,birthDate,primaryPosition' },
          timeout: 10000,
        }),
      ]);
      const person = infoR.data.people?.[0] || {};
      const birthYear = person.birthDate ? new Date(person.birthDate).getFullYear() : null;
      const position = person.primaryPosition?.abbreviation || '';
      const splits = statsR.data.stats?.[0]?.splits || [];
      const byYear = {};
      for (const s of splits) {
        const yr = s.season;
        const ip = parseFloat(s.stat?.inningsPitched) || 0;
        if (!byYear[yr] || ip > (parseFloat(byYear[yr].stat?.inningsPitched) || 0)) byYear[yr] = s;
      }
      return {
        birthYear, position,
        seasons: Object.values(byYear).sort((a, b) => a.season.localeCompare(b.season)).map(s => ({
          season:  s.season,
          team_id: s.team?.id || null,
          age:     birthYear ? parseInt(s.season) - birthYear : null,
          gp:      +(s.stat?.gamesPlayed) || 0,
          gs:      +(s.stat?.gamesStarted) || 0,
          ip:      parseFloat(s.stat?.inningsPitched) || 0,
          w:       +(s.stat?.wins) || 0,
          l:       +(s.stat?.losses) || 0,
          so:      +(s.stat?.strikeOuts) || 0,
          era:     s.stat?.era || '-.--',
          whip:    s.stat?.whip || '-.--',
          sv:      +(s.stat?.saves) || 0,
        })),
      };
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch MLB pitching stats' });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`NBA Stats app running at http://localhost:${PORT}`);
    console.log(`playerMeta loaded: ${Object.keys(PLAYER_META).length} birthdates`);
    console.log(`legends loaded: ${Object.keys(LEGENDS_STORE).length} stored careers`);
    // Pre-warm player cache in background
    cached('all-players', 24 * 3600 * 1000, buildPlayerList).catch(e =>
      console.error('Player cache warmup failed:', e.message)
    );
  });
}

module.exports = { buildBbrefCareer, BBREF_LEGENDS };
