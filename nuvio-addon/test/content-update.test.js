const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validateContent, readRemoteContent } = require('../remote-content');
const { createShiaProvider, mergeNewVideos } = require('../shiatube');
const video = { id: 'newEpisode000003', title: 'مسلسل تجريبي الحلقة 3', url: 'https://shiatube.org/watch/newEpisode000003' };
const snapshot = { series: [video], movies: [] };
const sources = { [video.id]: { source: 'https://preview.presstv.co.uk/ifilm/ar59417/3.mp4' } };
const state = { revision: crypto.createHash('sha256').update(JSON.stringify(snapshot) + '\n' + JSON.stringify(sources)).digest('hex'), updated: '2026-10-26T00:00:00Z' };

test('incremental indexing preserves history and does not change data for view counts', () => {
  const old = [{ ...video, views: '3' }];
  assert.equal(mergeNewVideos(old, [{ ...video, views: '10' }]), old);
  const added = { ...video, id: 'newEpisode000004' };
  assert.deepEqual(mergeNewVideos(old, [added, video]).map(v => v.id), [added.id, video.id]);
});
test('remote content requires complete and matching index and playback files', () => {
  assert.equal(validateContent(snapshot, sources, state).snapshot, snapshot);
  assert.throws(() => validateContent(snapshot, {}, state), /Missing playback/);
  assert.throws(() => validateContent(snapshot, sources, { revision: '0'.repeat(64) }), /do not match/);
});
test('unchanged remote revision downloads only the small state file', async () => {
  const calls = [];
  const result = await readRemoteContent(state.revision, async url => {
    calls.push(url);
    return Response.json(state);
  });
  assert.equal(result, null);
  assert.equal(calls.length, 1);
});
test('a new episode appears in the running service without a Render redeploy', async () => {
  let calls = 0;
  const provider = createShiaProvider({ series: [], movies: [] }, { readRemote: async () => { calls++; return validateContent(snapshot, sources, state); } });
  const catalog = await provider.catalog('series');
  assert.equal(catalog.length, 1);
  const meta = provider.detail('series', catalog[0].id).meta;
  assert.equal(meta.videos[0].episode, 3);
  const streams = await provider.streams('series', meta.videos[0].id);
  assert.equal(streams[0].url, sources[video.id].source);
  await provider.catalog('series');
  assert.equal(calls, 1);
});
test('GitHub failure preserves the working catalog', async () => {
  const provider = createShiaProvider(snapshot, { readRemote: async () => { throw new Error('GitHub unreachable'); } });
  assert.equal((await provider.catalog('series')).length, 1);
});
