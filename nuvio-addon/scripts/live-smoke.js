const assert = require('node:assert/strict');
const app = require('../server');
const server = app.listen(0, '127.0.0.1');
async function getPlaylist(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
  assert.equal(r.status, 200, `Playlist HTTP ${r.status}`);
  const text = await r.text();
  assert.match(text, /^#EXTM3U/);
  return text;
}
server.once('listening', async () => {
  const base = process.env.ADDON_URL || `http://127.0.0.1:${server.address().port}`;
  try {
    const manifest = await fetch(`${base}/manifest.json`).then(r => r.json());
    assert.equal(manifest.catalogs[0].name, 'TV Live');
    const catalog = await fetch(`${base}/catalog/tv/ifilmar-live.json`).then(r => r.json());
    assert.deepEqual(catalog.metas.map(x => x.name), ['iFilm', 'Al-Kawthar', 'Al-Maaref']);
    for (const item of catalog.metas) {
      const meta = await fetch(`${base}/meta/tv/${item.id}.json`).then(r => r.json());
      assert.equal(meta.meta.name, item.name);
      const r = await fetch(`${base}/stream/tv/${item.id}.json`);
      assert.equal(r.status, 200);
      const result = await r.json();
      assert.ok(result.streams?.length, `No streams: ${item.name}`);
      let url = result.streams[0].url;
      let text = await getPlaylist(url);
      if (text.includes('#EXT-X-STREAM-INF:')) {
        url = new URL(text.split(/\r?\n/).find(line => line.trim() && !line.startsWith('#')).trim(), url).href;
        text = await getPlaylist(url);
      }
      const segment = text.split(/\r?\n/).find(line => line.trim() && !line.startsWith('#'));
      assert.ok(segment, 'Empty live media playlist');
      const media = await fetch(new URL(segment.trim(), url), { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(25000) });
      assert.ok(media.ok, `${item.name}: segment HTTP ${media.status}`);
      const reader = media.body.getReader();
      const chunk = await reader.read(); await reader.cancel();
      assert.ok(chunk.value?.length, 'Empty segment');
      console.log(`${item.name}: HTTP catalog, metadata, HLS and live media segment OK (${media.status})`);
    }
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { server.closeAllConnections(); server.close(); }
});
