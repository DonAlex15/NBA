const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

// Player birthdate lookup: { "LeBron James": "1984-12-30", ... }
const PLAYER_META = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'playerMeta.json'), 'utf8')); }
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
  { id: '411', name: 'Michael Jordan',     team: '', debutYear: 1984 },
  { id: '501', name: 'Karl Malone',        team: '', debutYear: 1985 },
  { id: '592', name: 'Steve Nash',         team: '', debutYear: 1996 },
  { id: '609', name: 'Dirk Nowitzki',      team: '', debutYear: 1998 },
  { id: '614', name: "Shaquille O'Neal",   team: '', debutYear: 1992 },
  { id: '640', name: 'Gary Payton',        team: '', debutYear: 1990 },
];

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

  console.log(`Player cache built: ${players.length} players`);
  return players;
}

// Fetch career season-by-season stats from ESPN
async function buildCareerStats(espnId, debutYear, playerName) {
  const birthDate = playerName ? PLAYER_META[playerName] : null;
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
              team:     '',
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

  return seasons.sort((a, b) => a.season.localeCompare(b.season));
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
    res.json(filtered.slice(0, 10));
  } catch (e) {
    console.error('Players error:', e.message);
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});

// Career season-by-season stats
app.get('/api/career/:playerId', async (req, res) => {
  const { playerId } = req.params;
  try {
    const players = await cached('all-players', 24 * 3600 * 1000, buildPlayerList);
    const player = players.find(p => p.id === playerId);
    const debutYear = player?.debutYear || null;

    const seasons = await cached(
      `career-${playerId}`,
      24 * 3600 * 1000,
      () => buildCareerStats(playerId, debutYear, player?.name)
    );
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

app.listen(PORT, () => {
  console.log(`NBA Stats app running at http://localhost:${PORT}`);
  console.log(`playerMeta loaded: ${Object.keys(PLAYER_META).length} birthdates`);
  // Pre-warm player cache in background
  cached('all-players', 24 * 3600 * 1000, buildPlayerList).catch(e =>
    console.error('Player cache warmup failed:', e.message)
  );
});
