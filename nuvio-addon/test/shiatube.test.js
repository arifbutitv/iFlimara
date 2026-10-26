const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVideos, groupSeries, createShiaProvider, allowedMedia } = require('../shiatube');
const videos = [
  { id: 'kNisp9IJaMyCs02', title: 'المسلسل الايراني ( حرس السواحل ) الحلقة ٢', url: 'https://shiatube.org/watch/kNisp9IJaMyCs02', poster: 'https://shia1.b-cdn.net/poster.webp' },
  { id: 'kNisp9IJaMyCs01', title: 'المسلسل الايراني ( حرس السواحل ) الحلقة 1', url: 'https://shiatube.org/watch/kNisp9IJaMyCs01' },
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
  assert.equal(stream[0].url, '/shiatube/play/kNisp9IJaMyCs01.mp4');
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
