const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVideos, groupSeries, createShiaProvider, allowedMedia, parsePlayer, resolveVideo } = require('../shiatube');
const videos = [
  { id: 'fixtureEpisode002', title: 'المسلسل الايراني ( حرس السواحل ) الحلقة ٢', url: 'https://shiatube.org/watch/fixtureEpisode002', poster: 'https://shia1.b-cdn.net/poster.webp' },
  { id: 'fixtureEpisode001', title: 'المسلسل الايراني ( حرس السواحل ) الحلقة 1', url: 'https://shiatube.org/watch/fixtureEpisode001' },
];
const movie = { id: 'NdAzlvwA6yDEZwh', title: 'الفيلم الايراني ( بحيرة الأسماك ) مترجم', url: 'https://shiatube.org/watch/NdAzlvwA6yDEZwh' };
const snapshot = { series: videos, movies: [movie] };

test('ShiaTube groups Arabic numbered episodes and keeps ids stable', () => {
  const groups = groupSeries(videos);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].episodes.map(x => x.number), [1, 2]);
  assert.equal(groups[0].key, groupSeries([...videos].reverse())[0].key);
});
test('ShiaTube parses channel cards and excludes other uploaders', () => {
  const card = (owner, id) => `<div class="video-wrapper" data-id="42"><div class="video-title"><a href="https://shiatube.org/watch/عنوان_${id}.html"><h4>عنوان الحلقة 1</h4></a></div><div class="video-info"><a href="/@${owner}">${owner}</a></div></div>`;
  const entries = parseVideos(card('series', videos[0].id) + card('other', videos[1].id), 'series');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, videos[0].id);
});
test('ShiaTube searches both catalogs with Arabic letter normalization', async () => {
  const provider = createShiaProvider(snapshot, { refresh: false });
  assert.equal((await provider.catalog('series', { search: 'حرس السواحل' })).length, 1);
  assert.equal((await provider.catalog('movie', { search: 'الاسماك' })).length, 1);
  assert.equal((await provider.catalog('series', { search: 'الاسماك' })).length, 0);
  assert.equal((await provider.catalog('movie', { skip: 100 })).length, 0);
});
test('ShiaTube metadata and streams reference only indexed videos', async () => {
  const provider = createShiaProvider(snapshot, { refresh: false });
  const [series] = await provider.catalog('series');
  const detail = provider.detail('series', series.id);
  assert.equal(detail.meta.videos[0].episode, 1);
  const stream = await provider.streams('series', detail.meta.videos[0].id);
  assert.equal(stream[0].url, '/shiatube/play/fixtureEpisode001.mp4');
  assert.deepEqual(await provider.streams('series', `${series.id}:1:unknown`), []);
  assert.equal(provider.findVideo(movie.id).url, movie.url);
  assert.equal(provider.findVideo('unknown'), undefined);
});
test('media proxy destinations require HTTPS on known media hosts', () => {
  assert.equal(allowedMedia(new URL('https://vd434.okcdn.ru/video')), true);
  assert.equal(allowedMedia(new URL('https://evil.example/video')), false);
  assert.equal(allowedMedia(new URL('http://vd434.okcdn.ru/video')), false);
  assert.equal(allowedMedia(new URL('https://okcdn.ru.evil.example/video')), false);
});

test('official embed parser reads script-assigned direct media without evaluating code', () => {
  assert.equal(parsePlayer(`<script>$('video').attr('src', 'http://preview.presstv.ir/ifilm/ar59417/1.mp4');</script>`).source, 'http://preview.presstv.ir/ifilm/ar59417/1.mp4');
});

test('playback falls back to the official embed page when watch page fails', async () => {
  const calls = [];
  const url = await resolveVideo({ id: 'testFallback0001', url: 'https://shiatube.org/watch/testFallback0001' }, async target => {
    calls.push(String(target));
    if (calls.length === 1) return new Response('Forbidden', { status: 403 });
    return new Response(`<script>$('video').attr('src', 'http://preview.presstv.ir/ifilm/ar59417/1.mp4');</script>`);
  });
  assert.equal(calls[1], 'https://shiatube.org/embed/testFallback0001');
  assert.equal(url, 'https://preview.presstv.co.uk/ifilm/ar59417/1.mp4');
});

test('playback failures expose an upstream stage code without returning signed media URLs', async () => {
  await assert.rejects(() => resolveVideo({ id: 'testBlocked0001', url: 'https://shiatube.org/watch/testBlocked0001' }, async () => new Response('Forbidden', { status: 403 })), { code: 'SHIATUBE_HTTP_403' });
});

test('saved source for the reported episode works without any ShiaTube requests', async () => {
  const video = require('../data/shiatube.json').series.find(v => v.id === 'kNisp9IJaMyCs01');
  const url = await resolveVideo(video, async () => { throw new Error('No network request should be necessary'); });
  assert.equal(url, 'https://preview.presstv.co.uk/ifilm/ar59417/1.mp4');
});

test('saved OK.ru player reference resolves without reading a ShiaTube page', async () => {
  const references = require('../data/shiatube-sources.json');
  const [id] = Object.entries(references).find(([, hint]) => !hint.source && hint.iframe);
  const data = require('../data/shiatube.json');
  const video = [...data.series, ...data.movies].find(v => v.id === id);
  const calls = [];
  const url = await resolveVideo(video, async target => {
    const parsed = new URL(target);
    assert.equal(parsed.hostname, 'ok.ru');
    calls.push(parsed.pathname);
    const options = JSON.stringify({ flashvars: { metadata: { videos: [{ name: 'hd', url: 'https://vd434.okcdn.ru/public-test.mp4' }] } } }).replace(/"/g, '&quot;');
    return new Response(`<div data-options="${options}"></div>`);
  });
  assert.equal(calls.length, 1);
  assert.equal(url, 'https://vd434.okcdn.ru/public-test.mp4');
});

test('videos under review are detected as unavailable', () => {
  assert.equal(parsePlayer('<div class="video-processing">هذا الفيديو قيد المراجعة</div>').unavailable, true);
});

test('the reported episode returns its direct media URL rather than the blocked resolver', async () => {
  const data = require('../data/shiatube.json');
  const group = groupSeries(data.series).find(g => g.episodes.some(v => v.id === 'kNisp9IJaMyCs01'));
  const provider = createShiaProvider(data);
  const streams = await provider.streams('series', `shiatube:series:${group.key}:1:kNisp9IJaMyCs01`);
  assert.equal(streams[0].url, 'https://preview.presstv.co.uk/ifilm/ar59417/1.mp4');
});

test('every indexed video has a saved source or an explicit unavailable state', () => {
  const data = require('../data/shiatube.json');
  const references = require('../data/shiatube-sources.json');
  const missing = [...data.series, ...data.movies].filter(video => {
    const hint = references[video.id];
    return !hint || !(hint.source || hint.iframe || hint.unavailable);
  });
  assert.deepEqual(missing.map(video => video.id), []);
});
