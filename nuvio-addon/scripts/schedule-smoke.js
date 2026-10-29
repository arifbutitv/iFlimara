const assert = require('node:assert/strict');
const app = require('../server');
const server = app.listen(0, '127.0.0.1');
server.once('listening', async () => {
  const base = process.env.ADDON_URL || `http://127.0.0.1:${server.address().port}`;
  async function get(path) { const r = await fetch(base + path, { signal: AbortSignal.timeout(60000) }); assert.equal(r.status, 200, path); return r.json(); }
  try {
    const manifest = await get('/manifest.json');
    assert.equal(manifest.catalogs[1].name, 'جدول البث iFilm');
    const catalog = await get('/catalog/tv/ifilmar-schedule.json');
    assert.ok(catalog.metas.length);
    const sample = catalog.metas[0];
    const detail = await get(`/meta/tv/${sample.id}.json`);
    assert.match(detail.meta.description, /UTC\+3/);
    const search = await get(`/catalog/tv/ifilmar-schedule/search=${encodeURIComponent(sample.name.split(' — ')[1])}.json`);
    assert.ok(search.metas.some(x => x.id === sample.id));
    const streams = await get(`/stream/tv/${sample.id}.json`);
    assert.ok(streams.streams.length);
    console.log(`Schedule catalog: ${catalog.metas.length} entries on page 1; metadata, search and live stream OK`);
    console.log(sample.name);
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { server.closeAllConnections(); server.close(); }
});
