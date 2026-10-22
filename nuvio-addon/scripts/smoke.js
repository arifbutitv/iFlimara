const assert = require('node:assert/strict');
const { createProvider } = require('../provider');
const provider = createProvider();
(async () => {
  for (const type of ['series', 'movie']) {
    const catalog = await provider.catalog(type);
    assert.ok(catalog.length > 0, `${type} catalog is empty`);
    console.log(`${type}: ${catalog.length} catalog entries`);
  }
  const found = await provider.catalog('series', { search: 'العاصمة' });
  assert.ok(found.length > 0, 'Search returned no series');
  console.log(`Arabic search: ${found.length} series`);
  const meta = await provider.detail('series', 'ifilmar:series:74467');
  assert.ok(meta.meta.videos.length > 0, 'Episodes missing');
  const episodes = await provider.streams('series', meta.meta.videos[0].id);
  const film = await provider.streams('movie', 'ifilmar:movie:74595');
  for (const stream of [episodes[0], episodes[1], film[0]]) {
    assert.ok(stream?.url, 'Stream URL missing');
    const res = await fetch(stream.url, { headers: { Range: 'bytes=0-63' }, signal: AbortSignal.timeout(20000) });
    try {
      assert.ok(res.ok, `Media returned ${res.status}`);
      assert.match(res.headers.get('content-type') || '', /video|mpegurl/i);
      console.log(`Media OK: ${res.status} ${stream.url}`);
    } finally { await res.body?.cancel(); }
  }
  console.log(`Live checks passed; ${meta.meta.videos.length} episodes. Playback in Nuvio still requires a deployed server.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
