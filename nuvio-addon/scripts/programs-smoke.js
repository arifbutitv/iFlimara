const assert = require('node:assert/strict');
const app = require('../server');
const server = app.listen(0, '127.0.0.1');
server.once('listening', async () => {
  const base = process.env.ADDON_URL || `http://127.0.0.1:${server.address().port}`;
  async function get(path) { const r = await fetch(base + path, { signal: AbortSignal.timeout(60000) }); assert.equal(r.status, 200, path); return r.json(); }
  try {
    for (const [source, id] of [['ifilmar', '63344'], ['kawthar', '369639']]) {
      const catalog = await get(`/catalog/series/${source}-programs.json`);
      assert.ok(catalog.metas.length);
      const name = catalog.metas[0].name;
      const search = await get(`/catalog/series/${source}-programs/search=${encodeURIComponent(name)}.json`);
      assert.ok(search.metas.some(x => x.name === name));
      const detail = await get(`/meta/series/${source}-program:${id}.json`);
      assert.ok(detail.meta.videos.length);
      const episode = detail.meta.videos.at(-1);
      const stream = await get(`/stream/series/${episode.id}.json`);
      assert.ok(stream.streams.length);
      const r = await fetch(stream.streams[0].url, { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(25000) });
      assert.ok(r.ok, `Media HTTP ${r.status}`);
      const reader = r.body.getReader(), data = await reader.read(); await reader.cancel();
      assert.ok(data.value.length);
      console.log(`${source}: catalog ${catalog.metas.length}; search OK; ${detail.meta.name}: ${detail.meta.videos.length} episodes; media HTTP ${r.status}`);
    }
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { server.closeAllConnections(); server.close(); }
});
