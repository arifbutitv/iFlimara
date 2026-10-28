const test = require('node:test');
const assert = require('node:assert/strict');
const { createKawtharProvider, mediaUrl } = require('../kawthar');
const { createAddon } = require('../addon');
const card = (id, name, path = 'news') => `<a href="/${path}/${id}"><img src="/poster.jpg"><h2 class="news-title">${name}</h2></a>`;
const pager = path => `<span id="PagerBottom"><a href="${path}">التالي</a></span>`;
const landing = '<meta property="og:title" content="سيدة القصر"><meta property="og:video" content="https://cdn2.alkawthartv.ir/trailer.mp4"><a href="/category/2492?type=4"><h4 class="main-title">حلقات</h4></a>';
test('Kawthar search covers later pages, normalizes Arabic and deduplicates pagination', async () => {
  const calls = [];
  const provider = createKawtharProvider(async path => {
    calls.push(path);
    return path === '/category/629' ? card(1, 'غاندو') + pager('/category/629/2') : card(2, 'سيدة القصر') + pager('/category/629/2');
  });
  assert.equal((await provider.catalog('series', { search: 'سَيدة القصر' }))[0].id, 'kawthar:series:2');
  assert.equal((await provider.catalog('series')).length, 2);
  assert.equal(calls.length, 2);
});
test('Kawthar episodes paginate and sort; playback never uses the series trailer', async () => {
  const provider = createKawtharProvider(async path => {
    if (path === '/news/337676') return landing;
    if (path === '/category/2492?type=4') return card(20, 'الحلقة ٢') + pager('/category/2492?type=4&page=2');
    if (path === '/category/2492?type=4&page=2') return card(10, 'الحلقة ١');
    if (path === '/episode/10') return '<video src="https://cdn2.alkawthartv.ir/episode1.mp4"></video>';
    throw new Error(`Unexpected URL ${path}`);
  });
  const detail = await provider.detail('series', 'kawthar:series:337676');
  assert.deepEqual(detail.meta.videos.map(x => x.episode), [1, 2]);
  assert.equal((await provider.streams('series', detail.meta.videos[0].id))[0].url, 'https://cdn2.alkawthartv.ir/episode1.mp4');
  assert.deepEqual(await provider.streams('series', 'kawthar:series:337676'), []);
  assert.deepEqual(await provider.streams('series', 'kawthar:series:337676:1:999'), []);
});
test('Kawthar supports Namasha embeds and movie MP4 without accepting unrelated hosts', async () => {
  const provider = createKawtharProvider(async path => {
    if (path === '/news/1') return '<meta property="og:title" content="فيلم"><video src="https://cdn2.alkawthartv.ir/movie.mp4"></video>';
    if (path === '/news/2') return '<iframe src="https://www.namasha.com/embed/SRMPFU8Z"></iframe>';
    assert.equal(path, 'https://www.namasha.com/embed/SRMPFU8Z?autoplay=true');
    return "{'sources':[{'file':'https://s44.namasha.com/dash/123/Manifest.mpd'},{'file':'https://evil.example/video.mp4'}]}";
  });
  assert.match((await provider.streams('movie', 'kawthar:movie:1'))[0].url, /movie.mp4$/);
  assert.equal((await provider.streams('movie', 'kawthar:movie:2'))[0].url, 'https://s44.namasha.com/dash/123/Manifest.mpd');
  for (const url of ['http://cdn2.alkawthartv.ir/a.mp4', 'https://evil.example/a.mp4', 'https://cdn2.alkawthartv.ir.evil.example/a.mp4', 'https://s44.namasha.com:888/a.mp4']) assert.equal(mediaUrl(url), undefined);
  assert.deepEqual(await provider.streams('movie', 'kawthar:series:2'), []);
});
test('Addon routes both Kawthar catalogs, metadata and episode streams to their provider', async () => {
  const stub = { catalog: async type => [{ type }], detail: async (_type, id) => ({ meta: { id } }), streams: async () => [{ url: 'https://cdn2.alkawthartv.ir/a.mp4' }] };
  const addon = createAddon({}, {}, stub);
  assert.equal((await addon.get('catalog', 'series', 'kawthar-series')).metas[0].type, 'series');
  assert.equal((await addon.get('catalog', 'movie', 'kawthar-movie')).metas[0].type, 'movie');
  assert.equal((await addon.get('meta', 'movie', 'kawthar:movie:1')).meta.id, 'kawthar:movie:1');
  assert.equal((await addon.get('stream', 'series', 'kawthar:series:2:1:3')).streams.length, 1);
});
