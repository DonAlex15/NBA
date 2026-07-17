// One-off generator for legends.json — the frozen career stats of the
// historical Basketball-Reference legends. Run after editing BBREF_LEGENDS:
//   node fetchLegends.js
const fs = require('fs');
const path = require('path');
const { buildBbrefCareer, BBREF_LEGENDS } = require('./server');

(async () => {
  const store = {};
  for (const legend of BBREF_LEGENDS) {
    const bbrefId = legend.id.slice(4); // strip "bbr_"
    process.stdout.write(`Fetching ${legend.name} (${bbrefId})... `);
    try {
      const seasons = await buildBbrefCareer(bbrefId);
      store[legend.id] = seasons;
      console.log(`${seasons.length} seasons`);
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1500)); // be polite to BBRef
  }
  fs.writeFileSync(path.join(__dirname, 'legends.json'), JSON.stringify(store, null, 2));
  console.log(`\nWrote legends.json with ${Object.keys(store).length}/${BBREF_LEGENDS.length} players`);
})();
