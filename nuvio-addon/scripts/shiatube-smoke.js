const assert = require('node:assert/strict');
const app = require('../server');
const server = app.listen(0, '127.0.0.1');
server.once('listening', async () => {
  const base = process.env.ADDON_URL || `http://127.0.0.1:${server.address().port}`;
  try {
    for (const type of ['series', 'movie']) {
      const catalog = await fetch(`${base}/catalog/${type}/shiatube-${type}.json`).then(r => r.json());
      assert.ok(catalog.metas.length, `${type}: empty catalog`);
      console.log(`${type}: ${catalog.metas.length} entries`);
      const first = catalog.metas[0];
      const detail = await fetch(`${base}/meta/${type}/${first.id}.json`).then(r => r.json());
      assert.equal(detail.meta.id, first.id);
      const id = type === 'series' ? detail.meta.videos[0].id : first.id;
      if (type === 'series') console.log(`Episodes: ${detail.meta.videos.length}`);
      const streams = await fetch(`${base}/stream/${type}/${id}.json`).then(r => r.json());
      assert.ok(streams.streams[0]?.url, 'Missing stream');
      const media = await fetch(streams.streams[0].url, { headers: { Range: 'bytes=0-63' }, signal: AbortSignal.timeout(60000) });
      assert.equal(media.status, 206);
      assert.match(media.headers.get('content-type'), /video/);
      assert.equal((await media.arrayBuffer()).byteLength, 64);
      console.log(`${type}: ranged playback proxy OK`);
      const search = await fetch(`${base}/catalog/${type}/shiatube-${type}/search=${encodeURIComponent(first.name)}.json`).then(r => r.json());
      assert.ok(search.metas.some(m => m.id === first.id));
      console.log(`${type}: search OK`);
    }
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { server.closeAllConnections(); server.close(); }
});
