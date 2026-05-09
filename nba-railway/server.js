const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jqgybepennunjypbdlri.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpxZ3liZXBlbm51bmp5cGJkbHJpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyNzA1MDIsImV4cCI6MjA5Mzg0NjUwMn0.6DH2OCKO0wMeeHTBtoeGij3SXnCG7D_VZrwojjozuoo';

const sbHeaders = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
};

async function sbGet(table, params) {
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const r = await axios.get(url, { headers: sbHeaders, params, timeout: 10000 });
  return r.data;
}

// Simple in-memory cache
const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() < hit.exp) return Promise.resolve(hit.data);
  return fn().then(data => { cache.set(key, { data, exp: Date.now() + ttlMs }); return data; });
}

// Serve the UI
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Search players
app.get('/api/players', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    const rows = await sbGet('players', {
      'name': `ilike.*${q}*`,
      'select': 'id,name,debut_year',
      'limit': 10,
      'order': 'name.asc',
    });
    res.json(rows.map(p => ({ id: p.id, name: p.name, debutYear: p.debut_year })));
  } catch (e) {
    console.error('Player search error:', e?.response?.status, e?.message);
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});

// Get PPG for a player (most recent season in DB)
app.get('/api/ppg/:playerId', async (req, res) => {
  const { playerId } = req.params;
  try {
    const rows = await cached(`ppg-${playerId}`, 3600 * 1000, () => sbGet('career_stats', {
      'player_id': `eq.${playerId}`,
      'select': 'season,team,pts,gp',
      'order': 'season.desc',
      'limit': 1,
    }));
    if (!rows.length) return res.json(null);
    const r = rows[0];
    res.json({ gp: r.gp, pts: r.pts, team: r.team });
  } catch (e) {
    console.error('PPG error:', e?.response?.status, e?.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Get career season-by-season stats for a player
app.get('/api/career/:playerId', async (req, res) => {
  const { playerId } = req.params;
  try {
    const seasons = await cached(`career-${playerId}`, 24 * 3600 * 1000, () => sbGet('career_stats', {
      'player_id': `eq.${playerId}`,
      'select': 'season,team,team_id,age,gp,gs,min,pts,reb,oreb,dreb,ast,stl,blk,tov,pf,fgm,fga,fg_pct,fg3m,fg3a,fg3_pct,ftm,fta,ft_pct',
      'order': 'season.asc',
    }));
    res.json(seasons);
  } catch (e) {
    console.error('Career error:', e?.response?.status, e?.message);
    res.status(500).json({ error: 'Failed to fetch career stats' });
  }
});

// Standings — still call stats.nba.com (historical data, not blocked for this)
// If blocked, returns empty object gracefully
app.get('/api/standings/:season', async (req, res) => {
  res.json({});
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

app.listen(PORT, () => console.log(`NBA Stats app (Supabase) running at http://localhost:${PORT}`));
