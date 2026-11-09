const assert = require('node:assert/strict');
let blockedRequests = 0;
if (process.env.BLOCK_SHIATUBE === '1') {
  const originalFetch = global.fetch;
  global.fetch = (target, options) => {
    if (new URL(target).hostname === 'shiatube.org') {
      blockedRequests++;
      return Promise.resolve(new Response('Forbidden', { status: 403 }));
    }
    return originalFetch(target, options);
  };
}
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
      const stream = streams.streams[0];
      assert.match(stream?.externalUrl, /^https:\/\/shiatube\.org\/watch\//);
      assert.equal(stream.url, undefined);
      const legacy = await fetch(`${base}/shiatube/play/${id.split(':').at(-1)}.mp4`, { redirect: 'manual', headers: { Range: 'bytes=0-63' } });
      assert.equal(legacy.status, 302);
      assert.equal(legacy.headers.get('location'), stream.externalUrl);
      await legacy.text();
      console.log(`${type}: original watch link and legacy redirect OK`);
      const search = await fetch(`${base}/catalog/${type}/shiatube-${type}/search=${encodeURIComponent(first.name)}.json`).then(r => r.json());
      assert.ok(search.metas.some(m => m.id === first.id));
      console.log(`${type}: search OK`);
    }
    if (process.env.BLOCK_SHIATUBE === '1') {
      assert.equal(blockedRequests, 0, 'Playback must not request ShiaTube pages');
      console.log('No ShiaTube page requests were needed with origin access blocked');
    }
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { server.closeAllConnections(); server.close(); }
});
