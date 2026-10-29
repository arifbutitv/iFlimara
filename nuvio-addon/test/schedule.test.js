const test = require('node:test');
const assert = require('node:assert/strict');
const { entries, createScheduleProvider } = require('../schedule');
const { createAddon } = require('../addon');
const day = { strDate: '2026-10-29 00:00:00', NameDayOfWeek: 'الخميس' };
const rows = [{ ItemId: 1, Title: 'أربع شقق', Time: '00:00', GMT_Time: '21:00', Summary: 'برنامج أول', ImageLink: '/poster.jpg' }, { ItemId: 2, Title: 'حرس السواحل', Time: '01:00', GMT_Time: '22:00' }];
test('Schedule timestamps use Mecca midnight on the previous UTC date and preserve repeats', () => {
  const result = entries(day, [...rows, { ...rows[0], Time: '06:00' }]);
  assert.equal(new Date(result[0].start).toISOString(), '2026-10-28T21:00:00.000Z');
  assert.equal(result.length, 3);
  assert.equal(new Set(result.map(x => x.id)).size, 3);
  assert.equal(result[0].poster, 'https://ar.ifilmtv.ir/poster.jpg');
  assert.equal(entries(day, [{ ...rows[0], Time: '25:00' }]).length, 0);
});
test('Schedule refreshes from source automatically, searches Arabic and resolves only listed programs to live TV', async () => {
  let now = Date.parse('2026-10-28T21:30:00Z'), count = 0, version = 1;
  const live = { streams: async (type, id) => { assert.equal(type, 'tv'); assert.equal(id, 'ifilmar-live:ifilm'); return [{ url: 'https://live.presstv.co.uk/hls/ifilmar.m3u8' }]; } };
  const p = createScheduleProvider(live, async path => {
    count++;
    if (path === '/Schedule/PersionWeek') return [day];
    assert.equal(new URL(path, 'https://example.org').searchParams.get('strDate'), day.strDate);
    return version === 1 ? rows : [...rows, { ItemId: 3, Title: 'فيلم جديد', Time: '22:00' }];
  }, () => now);
  const first = await p.catalog('tv');
  assert.match(first[0].description, /^يعرض الآن/);
  assert.match(first[1].description, /^قادم/);
  assert.equal((await p.catalog('tv', { search: 'اربع شقق' })).length, 1);
  assert.deepEqual(await p.catalog('tv', { skip: 100 }), []);
  assert.equal(count, 2);
  version = 2; now += 301000;
  assert.equal((await p.catalog('tv')).length, 3);
  assert.equal(count, 4);
  assert.equal((await p.detail('tv', first[0].id)).meta.id, first[0].id);
  assert.equal((await p.streams('tv', first[0].id))[0].title, 'آي فيلم — البث المباشر للقناة');
  assert.deepEqual(await p.streams('tv', 'ifilmar-schedule:2026-10-29:2359:999'), []);
  assert.equal(await p.detail('tv', 'https://evil.example'), null);
});
test('Schedule catalog routes independently while TV Live remains first', async () => {
  const stub = { catalog: async () => [{ id: 'schedule' }], detail: async () => ({ meta: { name: 'برنامج' } }), streams: async () => [{ url: 'live' }] };
  const addon = createAddon({}, {}, {}, {}, stub);
  assert.equal(addon.manifest.catalogs[0].name, 'TV Live');
  assert.equal(addon.manifest.catalogs[1].name, 'جدول البث iFilm');
  assert.equal((await addon.get('catalog', 'tv', 'ifilmar-schedule')).metas[0].id, 'schedule');
  assert.equal((await addon.get('meta', 'tv', 'ifilmar-schedule:2026-10-29:0000:1')).meta.name, 'برنامج');
  assert.equal((await addon.get('stream', 'tv', 'ifilmar-schedule:2026-10-29:0000:1')).streams[0].url, 'live');
});
test('Schedule hides finished slots from browsing and search as time advances inside the cache period', async () => {
  let now = Date.parse('2026-10-28T21:59:00Z'), requests = 0;
  const p = createScheduleProvider({}, async path => {
    requests++;
    return path === '/Schedule/PersionWeek' ? [day] : rows;
  }, () => now);
  assert.equal((await p.catalog('tv'))[0].id, 'ifilmar-schedule:2026-10-29:0000:1');
  now += 60000;
  const current = await p.catalog('tv');
  assert.equal(current.length, 1);
  assert.equal(current[0].id, 'ifilmar-schedule:2026-10-29:0100:2');
  assert.match(current[0].description, /^يعرض الآن/);
  assert.deepEqual(await p.catalog('tv', { search: 'أربع شقق' }), []);
  assert.deepEqual(await p.catalog('tv', { skip: 1 }), []);
  assert.equal(requests, 2);
  now = Date.parse('2026-10-29T21:00:00Z');
  assert.deepEqual(await p.catalog('tv'), []);
});
test('Schedule keeps the current slot across Mecca midnight until the next published slot', async () => {
  const nextDay = { strDate: '2026-10-30 00:00:00', NameDayOfWeek: 'الجمعة' };
  const p = createScheduleProvider({}, async path => {
    if (path === '/Schedule/PersionWeek') return [day, nextDay];
    return new URL(path, 'https://example.org').searchParams.get('strDate') === day.strDate
      ? [{ ItemId: 10, Title: 'قبل منتصف الليل', Time: '23:30' }]
      : [{ ItemId: 11, Title: 'بعد منتصف الليل', Time: '00:30' }];
  }, () => Date.parse('2026-10-29T21:10:00Z'));
  const items = await p.catalog('tv');
  assert.equal(items.length, 2);
  assert.match(items[0].description, /^يعرض الآن/);
  assert.match(items[1].description, /^قادم/);
});
