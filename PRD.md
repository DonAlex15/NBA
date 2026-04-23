# Who's The Best? — Product Requirements Document

*Reverse-engineered from the live application*

---

## 1. Product Overview

**Who's The Best?** is a browser-based NBA player comparison tool that lets users select any two NBA players from history and compare their career statistics side by side. The app surfaces raw stats, contextual indicators (championships, MVP awards, team win %), and a configurable algorithm that produces a scored verdict on who the stronger player was.

---

## 2. Problem Statement

Comparing NBA players across eras is inherently subjective. Raw scoring averages ignore context — a player's era, team quality, longevity, and all-around contribution. Existing tools either present raw stats without synthesis, or produce opaque ratings users can't interrogate. This tool makes the comparison transparent and user-adjustable.

---

## 3. Target Users

- NBA fans who want data-backed answers to "who's better" debates
- Users with no programming background — the interface requires no technical knowledge
- Users who want to form their own opinion by adjusting the algorithm, not just accept a black-box rating

---

## 4. Core Features

### 4.1 Player Search
- Typeahead search against the full NBA player database (active and historical)
- Results show player name and current/last team
- Supports two simultaneous player slots (Player 1 vs Player 2)
- Data sourced from `commonallplayers` endpoint, cached for 24 hours

### 4.2 Stat Comparison Table
- Displays career stats season-by-season or aligned by age
- **By Age** is the default view (more meaningful for cross-era comparisons)
- Each cell shows the selected stat value with sub-info: season year, team, games played, team win %, championship indicator, MVP indicator
- Row highlighting: green background for the winning player in each row
- Diff column shows the gap and which player leads

### 4.3 Stat Selector
21 available stats via dropdown:

| Category | Stats |
|---|---|
| Scoring | PTS, FGM, FGA, FG%, 3PM, 3PA, 3P%, FTM, FTA, FT% |
| Rebounding | REB, OREB, DREB |
| Playmaking | AST |
| Defense | STL, BLK |
| Other | TOV, MIN, GP, GS, PF |

### 4.4 Contextual Indicators
- **🏆 Championship**: shown when the player's team won the NBA title that season
- **🏅 MVP**: shown when the player won the league MVP that season
- **Win %**: team's regular season win percentage that year, fetched from `leaguestandingsv3` and cached for 7 days (24h for current season)

### 4.5 View Modes
- **By Season**: all seasons from both careers listed chronologically
- **By Age**: seasons aligned by player age; when a player has multiple rows at the same age (due to mid-season trades), the row with the most games played is used

---

## 5. Algorithm — Who's The Best Score

The verdict card appears below the player search inputs and is collapsible. It shows an overall score bar and, when expanded, a breakdown of each component.

### 5.1 Overall Score

```
Overall Score = Stats × wStat% + MVPs × wMvp% + Championships × wChamp%
```

All three weights are user-adjustable and always sum to 100% (defaults: Stats 50%, MVPs 30%, Championships 20%).

### 5.2 MVP Score
Proportional share of total MVP awards between the two players. If neither has any, both score 50.

### 5.3 Championship Score
Count of seasons where the player's team won the NBA championship. Weighted lower than MVPs by default because championships depend heavily on teammates.

### 5.4 Statistical Performance Score

```
Stat Score = Career Avg × wCareer% + Peak × wPeak% + H2H × wH2h% + Longevity × wLon%
```

These four sub-weights are also user-adjustable and always sum to 100% (defaults: Career 40%, Peak 25%, H2H 20%, Longevity 15%).

#### Career Avg
Per-game composite score averaged across every season, weighted by games played within each season. Purely a rate stat — not sensitive to career length.

```
Composite = PTS×wPts + REB×wReb + AST×wAst + STL×wStl + BLK×wBlk − TOV×wTov
```

Per-stat multipliers are user-adjustable from 1× to 2× (defaults: PTS 1.0, REB 1.2, AST 1.5, STL 2.0, BLK 2.0, TOV 1.0). STL and BLK are weighted higher by default because they end a possession *and* create one — a double impact.

#### Peak
Average composite across the player's best 5 seasons. Rewards dominant primes even if the rest of the career was ordinary.

#### H2H — Head to Head
For every age *both* players played at, who had the higher composite that year? Win count normalized 0–100. Ages where only one player played are excluded (handled by the Longevity factor).

#### Longevity
A blend of three sub-components, weighted equally:

| Sub-component | What it measures |
|---|---|
| **Uncontested ages** | Ages where only one player played — credited to that player. Rewards longer careers directly. |
| **Total career value** | Composite × games played, summed across all seasons. Playing at a high level for more years accumulates more value than the same rate over fewer years. |
| **Sustained excellence** | Count of seasons where the player's composite exceeded the shared median composite of both players combined. Rewards consistent high-level performance over time. |

#### Verdict Language
| Score gap | Verdict |
|---|---|
| < 3 points | "Both players are essentially equal" |
| 3–8 points | "[Player] has a slight edge" |
| > 8 points | "[Player] appears to be the stronger player" |

---

## 6. Algorithm Weight Controls

Accessible via the **Algorithm Weights** collapsible panel below the verdict card. Three columns of sliders:

| Column | Controls | Constraint |
|---|---|---|
| Stat Composite Weights | Per-stat multipliers (PTS, REB, AST, STL, BLK, TOV) | 1× – 2×, independent |
| Stat Score Sub-Weights | Career / Peak / H2H / Longevity | Linked, always sums to 100% |
| Scoring Component Weights | Stats / MVPs / Championships | Linked, always sums to 100% |

Linked sliders: moving one redistributes the remainder proportionally across the others in 5% increments. The analysis re-renders instantly on any slider change.

---

## 7. Technical Architecture

```
Browser (vanilla HTML / CSS / JS)
    |  /api/* requests
    v
Node.js + Express  (server.js, port 3000)
    |  injects required headers, in-memory TTL cache
    v
stats.nba.com  (unofficial NBA Stats API)
```

No build step, no framework, no TypeScript. Two files: `server.js` and `index.html`.

### 7.1 NBA API Endpoints

| Endpoint | Purpose | Cache TTL |
|---|---|---|
| `commonallplayers` | Full player list for search | 24 hours |
| `playercareerstats` | Season-by-season career stats | 24 hours |
| `leaguestandingsv3` | Team win/loss records by season | 7 days (24h current season) |

### 7.2 Required Headers
The NBA Stats API blocks requests without spoofed browser headers:
```
x-nba-stats-origin: stats
x-nba-stats-token: true
Referer: https://www.nba.com/
Origin: https://www.nba.com
User-Agent: Mozilla/5.0 ...
```

### 7.3 Caching
Simple in-memory Map with TTL timestamps. Cache resets on server restart. Prevents redundant NBA API calls during a session.

### 7.4 Data Returned Per Career Season
`season, team, team_id, age, gp, gs, min, pts, reb, oreb, dreb, ast, stl, blk, tov, pf, fgm, fga, fg_pct, fg3m, fg3a, fg3_pct, ftm, fta, ft_pct`

---

## 8. Static Data (Hardcoded)

### 8.1 NBA Champions by Season
Complete lookup from 1956–57 through 2024–25, keyed by season ID → team abbreviation.

### 8.2 NBA MVP Winners by Season
Complete lookup from 1955–56 through 2024–25, keyed by season ID → player display name.

---

## 9. Known Limitations

| Limitation | Impact |
|---|---|
| No advanced stats in career endpoint | Composite uses only box score stats; no PER, BPM, or true shooting |
| H2H ignores non-overlapping ages | Partially addressed by the Longevity factor |
| Career avg is a rate stat | Does not reward longevity on its own; offset by Longevity sub-weight |
| Composite threshold for "elite seasons" is relative (shared median) | Changes with every new player pair |
| Championship lookup uses team abbreviation | Historical relocations (e.g. SEA→OKC) may occasionally mismatch |
| In-memory cache | Lost on server restart; not shared across instances |
| No mobile layout for Algorithm Weights panel | Three-column slider grid is cramped on small screens |

---

## 10. Potential Enhancements

- **Advanced stats**: fetch `MeasureType=Advanced` per season to use PIE, TS%, USG% in the composite
- **Longevity credit for uncontested ages in H2H**: currently handled only in the Longevity factor, not in the H2H sub-score directly
- **Playoff stats**: separate career track for postseason performance
- **Three-player comparison**: extend the UI to support a third slot
- **Shareable URLs**: encode selected players and weight configuration in the URL hash
- **Persistent cache**: write cache to disk so it survives server restarts
- **Reset weights button**: return all sliders to defaults in one click
