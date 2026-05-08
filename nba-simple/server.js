const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = 3000;

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

// Simple in-memory cache
const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() < hit.exp) return Promise.resolve(hit.data);
  return fn().then(data => { cache.set(key, { data, exp: Date.now() + ttlMs }); return data; });
}

function currentSeason() {
  const now = new Date();
  const y = now.getFullYear();
  return (now.getMonth() + 1) >= 10 ? `${y}-${String(y+1).slice(2)}` : `${y-1}-${String(y).slice(2)}`;
}

// Serve the UI
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Search players
app.get('/api/players', async (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  try {
    const players = await cached('all-players', 24 * 3600 * 1000, async () => {
      const r = await axios.get('https://stats.nba.com/stats/commonallplayers', {
        params: { LeagueID: '00', Season: currentSeason(), IsOnlyCurrentSeason: 0 },
        headers: NBA_HEADERS,
        timeout: 15000,
      });
      const rs = r.data.resultSets.find(x => x.name === 'CommonAllPlayers');
      return rs.rowSet.map(row => ({
        id: row[0],
        name: row[2],
        team: row[10],
        active: row[3] === 1,
      }));
    });

    const results = q
      ? players.filter(p => p.name.toLowerCase().includes(q)).slice(0, 10)
      : [];
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});

// Get PPG for a player
app.get('/api/ppg/:playerId', async (req, res) => {
  const { playerId } = req.params;
  const season = currentSeason();
  try {
    const stats = await cached(`ppg-${playerId}-${season}`, 3600 * 1000, async () => {
      const r = await axios.get('https://stats.nba.com/stats/playerdashboardbygeneralsplits', {
        params: {
          PlayerID: playerId, Season: season, SeasonType: 'Regular Season',
          PerMode: 'PerGame', MeasureType: 'Base',
          PlusMinus: 'N', PaceAdjust: 'N', Rank: 'N',
          Outcome: '', Location: '', Month: 0, SeasonSegment: '',
          DateFrom: '', DateTo: '', OpponentTeamID: 0,
          VsConference: '', VsDivision: '', GameSegment: '', Period: 0, LastNGames: 0,
        },
        headers: NBA_HEADERS,
        timeout: 15000,
      });
      const rs = r.data.resultSets.find(x => x.name === 'OverallPlayerDashboard');
      if (!rs || !rs.rowSet.length) return null;
      const headers = rs.headers;
      const row = rs.rowSet[0];
      const get = key => row[headers.indexOf(key)];
      return {
        gp: get('GP'),
        pts: get('PTS'),
        team: get('TEAM_ABBREVIATION'),
      };
    });
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Get career season-by-season PPG for a player
app.get('/api/career/:playerId', async (req, res) => {
  const { playerId } = req.params;
  try {
    const seasons = await cached(`career-${playerId}`, 24 * 3600 * 1000, async () => {
      let r;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          r = await axios.get('https://stats.nba.com/stats/playercareerstats', {
            params: { PlayerID: playerId, PerMode: 'PerGame', LeagueID: '00' },
            headers: NBA_HEADERS,
            timeout: 20000,
          });
          break;
        } catch (err) {
          if (attempt === 1) throw err;
          await new Promise(res => setTimeout(res, 2000));
        }
      }
      const rs = r.data.resultSets.find(x => x.name === 'SeasonTotalsRegularSeason');
      if (!rs) return [];
      const h = rs.headers;
      const get = (row, key) => row[h.indexOf(key)];
      return rs.rowSet.map(row => ({
        season:  get(row, 'SEASON_ID'),
        team:    get(row, 'TEAM_ABBREVIATION'),
        team_id: get(row, 'TEAM_ID'),
        age:     get(row, 'PLAYER_AGE'),
        gp:     get(row, 'GP'),
        gs:     get(row, 'GS'),
        min:    get(row, 'MIN'),
        pts:    get(row, 'PTS'),
        reb:    get(row, 'REB'),
        oreb:   get(row, 'OREB'),
        dreb:   get(row, 'DREB'),
        ast:    get(row, 'AST'),
        stl:    get(row, 'STL'),
        blk:    get(row, 'BLK'),
        tov:    get(row, 'TOV'),
        pf:     get(row, 'PF'),
        fgm:    get(row, 'FGM'),
        fga:    get(row, 'FGA'),
        fg_pct: get(row, 'FG_PCT'),
        fg3m:   get(row, 'FG3M'),
        fg3a:   get(row, 'FG3A'),
        fg3_pct:get(row, 'FG3_PCT'),
        ftm:    get(row, 'FTM'),
        fta:    get(row, 'FTA'),
        ft_pct: get(row, 'FT_PCT'),
      }));
    });
    res.json(seasons);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch career stats' });
  }
});

// Get team win% map for a season: { "LAL": 0.671, ... }
app.get('/api/standings/:season', async (req, res) => {
  const { season } = req.params;
  const ttl = season === currentSeason() ? 3600 * 1000 : 7 * 24 * 3600 * 1000;
  try {
    const data = await cached(`standings-${season}`, ttl, async () => {
      const r = await axios.get('https://stats.nba.com/stats/leaguestandingsv3', {
        params: { LeagueID: '00', Season: season, SeasonType: 'Regular Season' },
        headers: NBA_HEADERS,
        timeout: 15000,
      });
      const rs = r.data.resultSets.find(x => x.name === 'Standings');
      if (!rs) return {};
      const h = rs.headers;
      const get = (row, key) => row[h.indexOf(key)];
      const map = {};
      for (const row of rs.rowSet) {
        const teamId = get(row, 'TeamID');
        const w = get(row, 'WINS');
        const l = get(row, 'LOSSES');
        if (teamId && w != null && l != null && (w + l) > 0) {
          map[teamId] = w / (w + l);
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
          season:   s.season,
          team_id:  s.team?.id || null,
          age:      birthYear ? parseInt(s.season) - birthYear : null,
          gp:       +(s.stat?.gamesPlayed) || 0,
          ab:       +(s.stat?.atBats) || 0,
          hits:     +(s.stat?.hits) || 0,
          hr:       +(s.stat?.homeRuns) || 0,
          rbi:      +(s.stat?.rbi) || 0,
          avg:      s.stat?.avg || '0',
          obp:      s.stat?.obp || '0',
          slg:      s.stat?.slg || '0',
          ops:      s.stat?.ops || '0',
          sb:       +(s.stat?.stolenBases) || 0,
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

app.listen(PORT, () => console.log(`NBA Stats app running at http://localhost:${PORT}`));
