// One-time script: pulls all NBA players + career stats from stats.nba.com
// and populates Supabase.
// Run: node scripts/populate-supabase.js
//
// Set env vars or edit the constants below before running:
//   SUPABASE_URL=https://jqgybepennunjypbdlri.supabase.co
//   SUPABASE_KEY=eyJ...

const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jqgybepennunjypbdlri.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpxZ3liZXBlbm51bmp5cGJkbHJpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyNzA1MDIsImV4cCI6MjA5Mzg0NjUwMn0.6DH2OCKO0wMeeHTBtoeGij3SXnCG7D_VZrwojjozuoo';

const NBA_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true',
  'Referer': 'https://www.nba.com/',
  'Origin': 'https://www.nba.com',
  'Host': 'stats.nba.com',
  'Connection': 'keep-alive',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

const sbHeaders = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'resolution=merge-duplicates',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function nbaGet(url, params) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await axios.get(url, { params, headers: NBA_HEADERS, timeout: 20000 });
      return r.data;
    } catch (e) {
      if (attempt === 2) throw e;
      const wait = e?.response?.status === 503 ? 10000 : 3000;
      console.log(`  retrying after ${e?.response?.status || e.message} (wait ${wait}ms)...`);
      await sleep(wait);
    }
  }
}

async function sbUpsert(table, rows) {
  if (!rows.length) return;
  const r = await axios.post(`${SUPABASE_URL}/rest/v1/${table}`, rows, {
    headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
  });
  if (r.status >= 400) throw new Error(`Supabase upsert failed: ${r.status} ${JSON.stringify(r.data)}`);
}

async function fetchAllPlayers() {
  console.log('Fetching all players from stats.nba.com...');
  const data = await nbaGet('https://stats.nba.com/stats/commonallplayers', {
    LeagueID: '00', Season: '2024-25', IsOnlyCurrentSeason: 0,
  });
  const rs = data.resultSets.find(x => x.name === 'CommonAllPlayers');
  const players = rs.rowSet.map(row => ({
    id: String(row[0]),
    name: row[2],
    debut_year: row[6] ? parseInt(String(row[6]).slice(0, 4)) : null,
  }));
  console.log(`Found ${players.length} players`);
  return players;
}

async function fetchCareerStats(playerId) {
  const data = await nbaGet('https://stats.nba.com/stats/playercareerstats', {
    PlayerID: playerId, PerMode: 'PerGame', LeagueID: '00',
  });
  const rs = data.resultSets.find(x => x.name === 'SeasonTotalsRegularSeason');
  if (!rs || !rs.rowSet.length) return [];
  const h = rs.headers;
  const get = (row, key) => row[h.indexOf(key)];
  return rs.rowSet.map(row => ({
    player_id: String(playerId),
    season:   get(row, 'SEASON_ID'),
    team:     get(row, 'TEAM_ABBREVIATION'),
    team_id:  String(get(row, 'TEAM_ID')),
    age:      get(row, 'PLAYER_AGE'),
    gp:       get(row, 'GP'),
    gs:       get(row, 'GS'),
    min:      get(row, 'MIN'),
    pts:      get(row, 'PTS'),
    reb:      get(row, 'REB'),
    oreb:     get(row, 'OREB'),
    dreb:     get(row, 'DREB'),
    ast:      get(row, 'AST'),
    stl:      get(row, 'STL'),
    blk:      get(row, 'BLK'),
    tov:      get(row, 'TOV'),
    pf:       get(row, 'PF'),
    fgm:      get(row, 'FGM'),
    fga:      get(row, 'FGA'),
    fg_pct:   get(row, 'FG_PCT'),
    fg3m:     get(row, 'FG3M'),
    fg3a:     get(row, 'FG3A'),
    fg3_pct:  get(row, 'FG3_PCT'),
    ftm:      get(row, 'FTM'),
    fta:      get(row, 'FTA'),
    ft_pct:   get(row, 'FT_PCT'),
  }));
}

(async () => {
  try {
    // 1. Fetch and upsert all players
    const players = await fetchAllPlayers();
    console.log('Upserting players to Supabase...');
    for (let i = 0; i < players.length; i += 500) {
      await sbUpsert('players', players.slice(i, i + 500));
    }
    console.log('Players done.');

    // 2. Fetch career stats for each player
    let done = 0;
    const errors = [];
    for (const player of players) {
      try {
        const stats = await fetchCareerStats(player.id);
        if (stats.length) {
          await sbUpsert('career_stats', stats);
        }
      } catch (e) {
        errors.push({ id: player.id, name: player.name, error: e.message });
      }
      done++;
      if (done % 50 === 0) {
        process.stdout.write(`\r${done}/${players.length} players processed...`);
      }
      await sleep(1200); // be polite to stats.nba.com
    }

    console.log(`\nDone! ${done} players processed. ${errors.length} errors.`);
    if (errors.length) {
      console.log('Errors:', errors.slice(0, 10));
    }
  } catch (e) {
    console.error('Fatal error:', e.message);
    process.exit(1);
  }
})();
