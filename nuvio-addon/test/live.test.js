const test = require('node:test');
const assert = require('node:assert/strict');
const { createLiveProvider, hlsSources, allowedStream, oauthHeader } = require('../live');
test('TV Live lists exactly the three requested channels and supports Arabic search', async () => {
  const p = createLiveProvider(() => { throw new Error('Catalog must not fetch'); });
  assert.deepEqual((await p.catalog('tv')).map(x => x.name), ['iFilm', 'Al-Kawthar', 'Al-Maaref']);
  assert.equal((await p.catalog('tv', { search: 'المعارف' }))[0].id, 'ifilmar-live:almaaref');
  assert.equal((await p.catalog('tv', { search: 'iFilm' })).length, 1);
  assert.deepEqual(await p.catalog('tv', { skip: 100 }), []);
  assert.deepEqual(await p.streams('movie', 'ifilmar-live:ifilm'), []);
  assert.deepEqual(await p.streams('tv', 'ifilmar-live:unknown'), []);
  assert.equal(await p.detail('tv', 'ifilmar-live:unknown'), null);
});
test('Live parser reads source tags and HTML-encoded WordPress player JSON safely', () => {
  assert.deepEqual(hlsSources('<video srcjsplayer="https://live.presstv.co.uk/hls/ifilmar.m3u8"><source src="https://live.presstv.co.uk/hls/ifilmar.m3u8"></video>'), ['https://live.presstv.co.uk/hls/ifilmar.m3u8']);
  assert.deepEqual(hlsSources('<div data-item="{&quot;sources&quot;:[{&quot;src&quot;:&quot;https:\\/\\/bucharest.zeuscdn724.com\\/lb0\\/CH-AL-MA\\/index.m3u8&quot;}]}"></div>'), ['https://bucharest.zeuscdn724.com/lb0/CH-AL-MA/index.m3u8']);
  for (const u of ['http://live.presstv.co.uk/a.m3u8', 'https://evil.example/a.m3u8', 'https://live.presstv.co.uk.evil.example/a.m3u8', 'https://live.presstv.co.uk/a.mp4']) assert.equal(allowedStream(u), false);
});
test('Kawthar resolves a fresh signed URL with anonymous official player configuration and retries rotated client', async () => {
  let apiCalls = 0, scriptCalls = 0;
  const p = createLiveProvider(async (u, headers) => {
    if (u === 'https://www.alkawthartv.ir/live') return '<iframe src="https://sepehrtv.ir/frame/t/alkosar?logo=0"></iframe>';
    if (u.startsWith('https://sepehrtv.ir/frame/')) return '<script src="https://lb-cdn.sepehrtv.ir/_next/static/chunks/7164-test.js"></script>';
    if (u.includes('/_next/')) { scriptCalls++; return 'consumer:{key:"public-client",secret:"public-client-signing"}'; }
    assert.match(headers.Authorization, /^OAuth /);
    assert.match(headers.Authorization, /oauth_signature=/);
    apiCalls++;
    if (apiCalls === 1) { const e = new Error('Rotated client'); e.status = 401; throw e; }
    return JSON.stringify({ list: [{ uid: 'alkosar', streams: [{ src: 'https://lb-cdn.sepehrtv.ir/securelive/channel.m3u8?s=fresh' }, { src: 'https://evil.example/channel.m3u8' }] }] });
  });
  const first = await p.streams('tv', 'ifilmar-live:kawthar');
  assert.equal(first.length, 1);
  assert.match(first[0].url, /s=fresh$/);
  assert.deepEqual(await p.streams('tv', 'ifilmar-live:kawthar'), first);
  assert.equal(apiCalls, 2);
  assert.equal(scriptCalls, 2);
});
test('Live stream cache expires so signed links are refreshed', async () => {
  const original = Date.now;
  let now = original(), calls = 0;
  Date.now = () => now;
  try {
    const p = createLiveProvider(async u => u.includes('/Home/Live') ? `<source src="https://live.presstv.co.uk/hls/ifilmar.m3u8?v=${++calls}">` : '#EXTM3U\n#EXTINF:4,\nsegment.ts');
    await p.streams('tv', 'ifilmar-live:ifilm');
    await p.streams('tv', 'ifilmar-live:ifilm');
    assert.equal(calls, 1);
    now += 31000;
    const refreshed = await p.streams('tv', 'ifilmar-live:ifilm');
    assert.equal(calls, 2);
    assert.match(refreshed[0].url, /v=2$/);
  } finally { Date.now = original; }
});
test('iFilm excludes broken variants advertised by the official master playlist', async () => {
  const p = createLiveProvider(async u => {
    if (u.includes('/Home/Live')) return '<source src="https://live.presstv.co.uk/hls/ifilmar.m3u8">';
    if (u.endsWith('/ifilmar.m3u8')) return '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nbroken/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=888000\ngood/index.m3u8';
    if (u.includes('/broken/')) throw new Error('HTTP 404');
    return '#EXTM3U\n#EXTINF:4,\nsegment.ts';
  });
  const streams = await p.streams('tv', 'ifilmar-live:ifilm');
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://live.presstv.co.uk/hls/good/index.m3u8');
});
test('Anonymous OAuth signing is deterministic and escapes parameters', () => {
  const h = oauthHeader('https://example.org/api?q=a%20b', { key: 'public', secret: 'client' }, 'nonce', 100);
  assert.equal(h, oauthHeader('https://example.org/api?q=a%20b', { key: 'public', secret: 'client' }, 'nonce', 100));
  assert.match(h, /oauth_timestamp="100"/);
  assert.match(h, /oauth_signature="[^\"]+"/);
});
