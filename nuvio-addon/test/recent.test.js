const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { emptyIndex, observe, queryIndex, queryPage, updateIndex, readIndex, writeIndex, withIndexLock } = require('../recent-index');
const { createRecentProvider } = require('../recent');
const { createAddon } = require('../addon');
const T0 = '2026-11-27T00:00:00.000Z';
const T1 = '2026-11-27T00:30:00.000Z';
const item = (number, name = `عمل ${number}`) => ({ meta: { id: `ifilmar:movie:${number}`, type: 'movie', name, releaseInfo: '1995', poster: 'https://example.org/poster.jpg' } });

test('Recent identity deduplicates original IDs across catalogs, never titles, and preserves routes and firstSeenAt', () => {
  const index = emptyIndex();
  observe(index, 'ifilmar-series', [{ meta: { id: 'ifilmar:series:12', type: 'series', name: 'عنوان' }, baseline: true }], T0);
  observe(index, 'ifilmar-programs', [{ meta: { id: 'ifilmar-program:12', type: 'series', name: 'عنوان آخر' } }], T1);
  observe(index, 'ifilmar-series', [{ meta: { id: 'ifilmar:series:12', type: 'series', name: 'اسم محدث', poster: 'new.jpg' } }], T1);
  observe(index, 'ifilmar-movie', [{ ...item(13, 'اسم محدث'), baseline: true }], T1);
  assert.equal(Object.keys(index.records).length, 2);
  const original = index.records['ifilm:12'];
  assert.equal(original.meta.id, 'ifilmar:series:12');
  assert.equal(original.meta.type, 'series');
  assert.equal(original.meta.name, 'اسم محدث');
  assert.equal(original.firstSeenAt, T0);
  assert.equal(queryIndex(index).find(x => x.id === original.meta.id).addedAt, null);
  assert.equal(queryIndex(index).find(x => x.id === 'ifilmar:movie:13').addedAt, null);
});

test('Recent ranking uses trusted source addition time or first detection and ignores production/release years', () => {
  const index = emptyIndex();
  observe(index, 'movies', [{ ...item(1), baseline: true }, { ...item(2), sourceAddedAt: '2026-11-26T23:00:00.000Z', baseline: true }], T0);
  observe(index, 'movies', [{ ...item(3), baseline: false }], T1);
  assert.deepEqual(queryIndex(index).map(x => x.id), ['ifilmar:movie:3', 'ifilmar:movie:2', 'ifilmar:movie:1']);
  assert.equal(queryIndex(index)[0].addedAt, T1);
  assert.equal(queryIndex(index)[1].addedAtSource, 'source');
  assert.equal(queryIndex(index)[2].addedAtSource, 'unknown');
  observe(index, 'movies', [{ ...item(4), baseline: true, sourceAddedAt: '2099-01-01T00:00:00.000Z' }], T1);
  assert.equal(index.records['ifilm:4'].sourceAddedAt, null);
});

test('Recent baseline completes incrementally and historical backfill never becomes a new addition', async () => {
  const index = emptyIndex();
  let rows = Array.from({ length: 210 }, (_, i) => item(i + 1));
  const source = { key: 'movies', page: async skip => rows.slice(skip, skip + 100) };
  await updateIndex(index, [source], { now: () => Date.parse(T0), pageBudget: 2 });
  assert.equal(index.sources.movies.initialized, false);
  assert.equal(index.sources.movies.cursor, 200);
  await updateIndex(index, [source], { now: () => Date.parse(T1), pageBudget: 2 });
  assert.equal(index.sources.movies.initialized, true);
  assert.ok(queryIndex(index).every(x => x.addedAt === null));
  rows = [item(999), ...rows, item(1000, 'اكتشاف قديم')];
  await updateIndex(index, [source], { now: () => Date.parse('2026-11-27T01:00:00Z'), pageBudget: 5 });
  assert.equal(queryIndex(index)[0].id, 'ifilmar:movie:999');
  assert.equal(index.records['ifilm:1000'].baseline, true);
  assert.equal(index.records['ifilm:1'].firstSeenAt, T0);
});

test('Recent source failure rolls back its partial pages while successful sources commit and records survive', async () => {
  const index = emptyIndex();
  await updateIndex(index, [{ key: 'bad', page: async () => [item(1)] }], { now: () => Date.parse(T0) });
  const failure = { key: 'bad', page: async skip => { if (skip) throw new Error('page failed'); return Array.from({ length: 100 }, (_, i) => item(i + 20)); } };
  await updateIndex(index, [failure, { key: 'good', page: async () => [item(500)] }], { now: () => Date.parse(T1) });
  assert.ok(index.records['ifilm:1']);
  assert.equal(index.records['ifilm:20'], undefined);
  assert.ok(index.records['ifilm:500']);
  assert.equal(index.sources.bad.error, 'page failed');
});

test('Recent pagination pins a durable revision across additions and renames with deterministic date ties', async () => {
  const index = emptyIndex();
  observe(index, 'movies', Array.from({ length: 251 }, (_, i) => ({ ...item(i + 1, `برنامج ${i}`), baseline: false })), T0);
  await updateIndex(index, [], { now: () => Date.parse(T0) });
  const first = queryPage(index);
  const originalIds = Object.values(index.records).map(x => x.meta.id).sort();
  observe(index, 'movies', [item(999, 'أحدث')], T1);
  observe(index, 'movies', [item(1, 'عنوان مختلف')], T1);
  await updateIndex(index, [], { now: () => Date.parse(T1) });
  const second = queryPage(index, { skip: 100, revision: first.recentRevision });
  const third = queryPage(index, { skip: 200, revision: first.recentRevision });
  assert.deepEqual([...first.metas, ...second.metas, ...third.metas].map(x => x.id).sort(), originalIds);
  assert.equal(queryPage(index).metas[0].id, 'ifilmar:movie:999');
  assert.equal(queryPage(index, { revision: 1, search: 'برنامج 0' }).metas.length, 1);
});

test('Recent ledger and pinned page order survive reopening a durable file and overlapping writers are rejected', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ifilmar-recent-'));
  const file = path.join(directory, 'recent.json');
  try {
    await withIndexLock(file, async () => {
      const index = readIndex(file);
      observe(index, 'movies', [{ ...item(1), baseline: true }], T0);
      await updateIndex(index, [], { now: () => Date.parse(T0) });
      writeIndex(file, index);
      await assert.rejects(withIndexLock(file, async () => {}), { code: 'EEXIST' });
    });
    const reopened = readIndex(file);
    assert.equal(reopened.records['ifilm:1'].firstSeenAt, T0);
    assert.equal(queryPage(reopened, { revision: 1 }).metas[0].id, 'ifilmar:movie:1');
    await withIndexLock(file, async () => writeIndex(file, reopened));
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('ifilmar-recent-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Recent reader serves only saved data, retains valid cache on refresh failure, and survives a new reader instance', async () => {
  const index = emptyIndex(); observe(index, 'movies', [item(1)], T0);
  await updateIndex(index, [], { now: () => Date.parse(T0) });
  let calls = 0, fail = false;
  const get = async () => { calls++; if (fail) throw new Error('offline'); return Response.json(index); };
  const reader = createRecentProvider({ get });
  await reader.refresh();
  for (let i = 0; i < 5; i++) assert.equal((await reader.catalog('other')).metas.length, 1);
  assert.equal(calls, 1);
  const restarted = createRecentProvider({ get }); await restarted.refresh();
  assert.deepEqual(await restarted.catalog('other'), await reader.catalog('other'));
  fail = true; await assert.rejects(reader.refresh(), /offline/);
  assert.equal((await reader.catalog('other')).metas[0].id, 'ifilmar:movie:1');
});

test('Recent mixed catalog returns original types and dispatches details and streams to existing providers', async () => {
  const index = emptyIndex();
  observe(index, 'movies', [item(1), { meta: { id: 'ifilmar:series:2', type: 'series', name: 'مسلسل' } }], T0);
  const legacy = { detail: async (type, id) => ({ meta: { type, id } }), streams: async (type, id) => [{ url: `https://example.org/${type}/${id}` }] };
  const recent = { catalog: async () => queryPage(index) };
  const addon = createAddon(legacy, legacy, legacy, legacy, legacy, legacy, legacy, legacy, legacy, recent);
  const result = await addon.get('catalog', 'other', 'ifilmar-recent');
  for (const meta of result.metas) {
    assert.deepEqual((await addon.get('meta', meta.type, meta.id)).meta, { id: meta.id, type: meta.type });
    assert.ok((await addon.get('stream', meta.type, meta.id)).streams.length);
  }
});

test('ShiaTube original episode aliases keep firstSeenAt when a group title and its derived route change', () => {
  const index = emptyIndex();
  const original = { meta: { id: 'shiatube:series:oldhash', type: 'series', name: 'اسم قديم' }, aliases: ['shiatube-series-video:one'], baseline: true };
  observe(index, 'shiatube-series', [original], T0);
  observe(index, 'shiatube-series', [{ ...original, meta: { ...original.meta, id: 'shiatube:series:newhash', name: 'اسم مصحح' }, aliases: ['shiatube-series-video:two', 'shiatube-series-video:one'] }], T1);
  assert.equal(Object.keys(index.records).length, 1);
  assert.equal(queryIndex(index)[0].firstSeenAt, T0);
  assert.equal(queryIndex(index)[0].id, 'shiatube:series:newhash');
});
