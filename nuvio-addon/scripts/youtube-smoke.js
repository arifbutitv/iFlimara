const assert = require('node:assert/strict');
const app = require('../server');
const server = app.listen(0, '127.0.0.1');
server.once('listening', async () => {
  const base = process.env.ADDON_URL || `http://127.0.0.1:${server.address().port}`;
  async function get(path) { const r = await fetch(base + path, { signal: AbortSignal.timeout(90000) }); assert.equal(r.status, 200, path); return r.json(); }
  try {
    const manifest = await get('/manifest.json');
    assert.equal(manifest.catalogs[8].name, 'يوتيوب نورا دراما');
    const catalog = await get('/catalog/series/noradrama-playlists.json');
    assert.ok(catalog.metas.length);
    for (const channel of ['نورا دراما', 'إشراق']) {
      const search = await get(`/catalog/series/noradrama-playlists/search=${encodeURIComponent(channel)}.json`);
      assert.ok(search.metas.length, `Missing channel ${channel}`);
      const item = search.metas[0];
      const page = await get(`/meta/series/${item.id}.json`);
      assert.ok(page.meta.videos.length, `Empty playlist ${item.name}`);
      const stream = await get(`/stream/series/${page.meta.videos[0].id}.json`);
      assert.match(stream.streams[0]?.externalUrl, /^https:\/\/www.youtube.com\/watch\?v=/);
      assert.equal(stream.streams[0]?.url, undefined);
      console.log(`${channel}: ${search.metas.length} playlists; ${item.name}: ${page.meta.videos.length} videos; official YouTube link OK`);
    }
    console.log(`Combined catalog: ${catalog.metas.length} playlists`);
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { server.closeAllConnections(); server.close(); }
});
