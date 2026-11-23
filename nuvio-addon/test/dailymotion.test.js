const test = require('node:test');
const assert = require('node:assert/strict');
const { createDailymotionProvider } = require('../dailymotion');
test('Dailymotion paginates, searches Arabic, orders episodes and verifies playlist membership', async () => {
  const provider = createDailymotionProvider(async path => {
    const url = new URL(path, 'https://api.dailymotion.com');
    if (url.pathname.includes('/user/')) return url.searchParams.get('page') === '1'
      ? { list: [{ id: 'xone', name: 'أيام' }], has_more: true }
      : { list: [{ id: 'xtwo', name: 'مسلسل آخر' }], has_more: false };
    assert.equal(url.pathname, '/playlist/xone/videos');
    return { list: [{ id: 'v2', title: 'أيام الحلقة ٢' }, { id: 'v1', title: 'أيام الحلقة 1' }], has_more: false };
  });
  assert.equal((await provider.catalog('series')).length, 2);
  assert.equal((await provider.catalog('series', { search: 'ايام' }))[0].id, 'dailymotion:xone');
  assert.equal((await provider.catalog('series', { skip: 1 }))[0].id, 'dailymotion:xtwo');
  const detail = await provider.detail('series', 'dailymotion:xone');
  assert.deepEqual(detail.meta.videos.map(x => x.episode), [1, 2]);
  assert.equal((await provider.streams('series', detail.meta.videos[0].id))[0].externalUrl, 'https://www.dailymotion.com/video/v1');
  assert.deepEqual(await provider.streams('series', 'dailymotion:xone:1:forged'), []);
  assert.equal(await provider.detail('series', 'dailymotion:unknown'), null);
  assert.deepEqual(await provider.catalog('movie'), []);
});
test('Dailymotion refreshes new playlists and videos automatically and retains data on transient errors', async () => {
  let now = 0, updated = false, fail = false;
  const provider = createDailymotionProvider(async path => {
    if (fail) throw new Error('Temporary outage');
    const list = path.startsWith('/user/')
      ? [{ id: 'xone', name: 'مسلسل' }, ...(updated ? [{ id: 'xtwo', name: 'جديد' }] : [])]
      : [{ id: 'v1', title: 'الحلقة 1' }, ...(updated ? [{ id: 'v2', title: 'الحلقة 2' }] : [])];
    return { list, has_more: false };
  }, () => now);
  assert.equal((await provider.catalog('series')).length, 1);
  assert.equal((await provider.detail('series', 'dailymotion:xone')).meta.videos.length, 1);
  updated = true; now += 1800001;
  const current = await provider.catalog('series');
  assert.equal(current.length, 2);
  assert.equal((await provider.detail('series', 'dailymotion:xone')).meta.videos.length, 2);
  fail = true; now += 1800001;
  assert.deepEqual(await provider.catalog('series'), current);
});
