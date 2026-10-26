const fs = require('node:fs');
const path = require('node:path');
const { syncRecentChannel } = require('../shiatube');
const filename = path.join(__dirname, '../data/shiatube.json');
(async () => {
  const snapshot = JSON.parse(fs.readFileSync(filename));
  let changed = false;
  for (const channel of ['series', 'movies']) {
    const old = snapshot[channel];
    const videos = await syncRecentChannel(channel, old);
    console.log(`${channel}: ${videos.length - old.length} new videos`);
    if (videos !== old) { snapshot[channel] = videos; changed = true; }
  }
  if (changed) {
    snapshot.updated = new Date().toISOString();
    fs.writeFileSync(filename, JSON.stringify(snapshot));
  } else console.log('Catalog unchanged');
})().catch(error => { console.error(error); process.exitCode = 1; });
