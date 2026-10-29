const test = require('node:test');
const assert = require('node:assert/strict');
const { createProvider, mediaUrl, parseId } = require('../provider');
const { createAddon } = require('../addon');

const series = `<meta property="og:title" content="العاصمة 7 (2024)"><meta property="og:image" content="/poster.jpg"><script>var extrafild="archive"; var inter_ = 23;</script><video><source src="https://fa.ifilmtv.ir/UploadedFiles/Video/trailer.mp4"></video>`;
const movie = `<meta property="og:title" content="المعطر (2022)"><video><source src="https://fa.ifilmtv.ir//UploadedFiles/Video/10-04-1448/movie.mp4"></video>`;

test('catalog pagination yields 100 entries then continues without a gap', async () => {
  const provider = createProvider(async path => {
    const page = Number(new URL(path, 'https://example.org').searchParams.get('page'));
    return '<div class="content-all-film">' + Array.from({ length: 18 }, (_, i) => `<a class="inner-panel" href="/series/Content/${(page - 1) * 18 + i + 1}"><h6>عنوان</h6><img src="/poster.jpg"></a>`).join('') + '</div>';
  });
  const first = await provider.catalog('series');
  const second = await provider.catalog('series', { skip: '100' });
  assert.equal(first.length, 100);
  assert.equal(first[99].id, 'ifilmar:series:100');
  assert.equal(second[0].id, 'ifilmar:series:101');
});

test('Arabic search is encoded and news and wrong types are excluded', async () => {
  const provider = createProvider(async (path, json) => {
    assert.equal(json, true);
    assert.equal(new URL(path, 'https://example.org').searchParams.get('searchstring'), 'العاصمة & 7');
    return [{ Id: 1, CategoryId: 11, Title: 'خبر' }, { Id: 2, CategoryId: 3, Title: 'مسلسل' }, { Id: 3, CategoryId: 5, Title: 'فيلم' }];
  });
  const found = await provider.catalog('series', { search: 'العاصمة & 7' });
  assert.deepEqual(found.map(x => x.id), ['ifilmar:series:2']);
});

test('series exposes episodes and HLS/MP4, never its trailer', async () => {
  const provider = createProvider(async () => series);
  const detail = await provider.detail('series', 'ifilmar:series:74467');
  assert.equal(detail.meta.videos.length, 23);
  assert.equal(detail.meta.videos[0].id, 'ifilmar:series:74467:1:1');
  const streams = await provider.streams('series', 'ifilmar:series:74467:1:23');
  assert.equal(streams.length, 2);
  assert.match(streams[0].url, /,23,23_320,/);
  assert.match(streams[1].url, /ar74467\/23.mp4$/);
  assert.equal((await provider.streams('series', 'ifilmar:series:74467:1:24')).length, 0);
});

test('film resolves to working CDN and unavailable films return no streams', async () => {
  const provider = createProvider(async () => movie);
  const streams = await provider.streams('movie', 'ifilmar:movie:74595');
  assert.equal(streams[0].url, 'https://preview.presstv.co.uk/ifilm/UploadedFiles/Video/10-04-1448/movie.mp4');
  const unavailable = createProvider(async () => '<meta property="og:title" content="فيلم بدون فيديو">');
  assert.deepEqual(await unavailable.streams('movie', 'ifilmar:movie:74402'), []);
});

test('legacy episodes paginate, deduplicate and resolve their videos', async () => {
  const provider = createProvider(async (path, json) => {
    if (!json) return '<meta property="og:title" content="مسلسل قديم">';
    if (path.includes('page=1&')) return [{ Episode: 2, VideoAddress: '/UploadedFiles/Video/two.mp4' }, { Episode: 1, VideoAddress: '/UploadedFiles/Video/one.mp4' }];
    return [];
  });
  const detail = await provider.detail('series', 'ifilmar:series:123');
  assert.deepEqual(detail.meta.videos.map(x => x.episode), [1, 2]);
  const streams = await provider.streams('series', 'ifilmar:series:123:1:1');
  assert.match(streams[0].url, /preview.presstv.co.uk\/ifilm\/UploadedFiles\/Video\/one.mp4$/);
});

test('rejects arbitrary identifiers and remote media hosts', async () => {
  assert.equal(parseId('https://example.org'), null);
  assert.equal(mediaUrl('https://example.org/file.mp4'), undefined);
  const provider = createProvider(async () => { throw new Error('Must not fetch'); });
  assert.deepEqual(await provider.streams('movie', 'ifilmar:series:123'), []);
});

test('addon exposes protocol meta and stream responses', async () => {
  const addon = createAddon(createProvider(async () => movie));
  const meta = await addon.get('meta', 'movie', 'ifilmar:movie:74595', {});
  assert.equal(meta.meta.name, 'المعطر (2022)');
  const streams = await addon.get('stream', 'movie', 'ifilmar:movie:74595', {});
  assert.equal(streams.streams.length, 1);
});

test('HTTP manifest supports CORS, health and rejects unknown paths', async () => {
  const app = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${origin}/manifest.json`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const manifest = await response.json();
    assert.equal(manifest.logo, `${origin}/assets/arifbuti-vip.png`);
    const logo = await fetch(manifest.logo);
    assert.equal(logo.status, 200);
    assert.match(logo.headers.get('content-type'), /image\/png/);
    assert.equal(manifest.catalogs.length, 10);
    assert.deepEqual(manifest.catalogs.map(c => c.id), ['ifilmar-live', 'ifilmar-schedule', 'ifilmar-series', 'ifilmar-movie', 'ifilmar-programs', 'kawthar-series', 'kawthar-movie', 'kawthar-programs', 'shiatube-series', 'shiatube-movie']);
    for (const source of ['ifilmar', 'kawthar']) assert.equal(manifest.catalogs.findIndex(c => c.id === `${source}-programs`), manifest.catalogs.findIndex(c => c.id === `${source}-movie`) + 1);
    assert.equal(manifest.catalogs[1].name, 'جدول البث iFilm');
    assert.equal(manifest.catalogs[0].name, 'TV Live');
    const live = await fetch(`${origin}/catalog/tv/ifilmar-live.json`).then(r => r.json());
    assert.deepEqual(live.metas.map(x => x.name), ['آي فيلم', 'الكوثر', 'المعارف', 'الإيمان', 'النعيم', 'الجوادين', 'الغدير']);
    const liveMeta = await fetch(`${origin}/meta/tv/ifilmar-live:almaaref.json`).then(r => r.json());
    assert.equal(liveMeta.meta.name, 'المعارف');
    for (const item of live.metas) {
      assert.match(item.poster, new RegExp(`^${origin}/assets/live/`));
      const artwork = await fetch(item.poster);
      assert.equal(artwork.status, 200);
      assert.match(artwork.headers.get('content-type'), /image\/png/);
      const png = Buffer.from(await artwork.arrayBuffer());
      assert.equal(png.readUInt32BE(16), 512);
      assert.equal(png.readUInt32BE(20), 512);
    }
    assert.equal(manifest.name, 'ArifButi VIP');
    assert.ok(manifest.catalogs.every(x => x.extra.some(e => e.name === 'search')));
    assert.equal((await fetch(`${origin}/health`).then(r => r.json())).status, 'ok');
    assert.equal((await fetch(`${origin}/not-an-endpoint`)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
