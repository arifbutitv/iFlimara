const fs = require('node:fs');
const path = require('node:path');
const { syncChannel, groupSeries } = require('../shiatube');
(async () => {
  fs.mkdirSync(path.join(__dirname, '../data'), { recursive: true });
  const checkpoint = path.join(__dirname, '../data/.shiatube-checkpoint.json');
  const snapshot = fs.existsSync(checkpoint) ? JSON.parse(fs.readFileSync(checkpoint)) : { updated: new Date().toISOString() };
  for (const channel of ['series', 'movies']) {
    snapshot[channel] = await syncChannel(channel, videos => {
      snapshot[channel] = videos;
      fs.writeFileSync(checkpoint, JSON.stringify(snapshot));
      if (videos.length % 100 === 0 || videos.length === 20) console.log(`${channel}: ${videos.length}`);
    }, snapshot[channel] || []);
    console.log(`${channel} complete: ${snapshot[channel].length}`);
  }
  console.log(`Series groups: ${groupSeries(snapshot.series).length}`);
  fs.mkdirSync(path.join(__dirname, '../data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '../data/shiatube.json'), JSON.stringify(snapshot));
  fs.unlinkSync(checkpoint);
})().catch(error => { console.error(error); process.exitCode = 1; });
