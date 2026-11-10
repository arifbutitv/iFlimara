const test = require('node:test');
const assert = require('node:assert/strict');
const { createYouTubeProvider, initialData, parseContent } = require('../youtube');
const playlistA = 'PLaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const playlistB = 'PLbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const playlistC = 'PLcccccccccccccccccccccccccccccc';
function item(id, name, kind = 'PLAYLIST') { return { lockupViewModel: { contentId: id, contentType: `LOCKUP_CONTENT_TYPE_${kind}`, metadata: { lockupMetadataViewModel: { title: { content: name } } }, contentImage: { thumbnailViewModel: { image: { sources: [{ url: 'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg', width: 480 }] } } } } }; }
function data(items) { return { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true, content: { sectionListRenderer: { contents: items } } } }] } } }; }
function html(items) { return `<script>var ytInitialData = ${JSON.stringify(data(items))};</script><script>ytcfg.set({"INNERTUBE_CLIENT_VERSION":"test-version"});</script>`; }
test('YouTube parser supports modern and legacy public renderers and ignores unrelated tabs', () => {
  const j = data([item(playlistA, 'اسم فيه } وعلامة " اقتباس'), { gridPlaylistRenderer: { playlistId: playlistB, title: { runs: [{ text: 'إشراق' }] } } }]);
  j.contents.twoColumnBrowseResultsRenderer.tabs.push({ tabRenderer: { content: item(playlistC, 'قائمة خارج القسم المختار') } });
  const parsed = parseContent(initialData(`<script>var ytInitialData = ${JSON.stringify(j)};</script>`), 'playlists');
  assert.deepEqual(parsed.items.map(x => x.key), [playlistA, playlistB]);
  assert.equal(parsed.items[0].name, 'اسم فيه } وعلامة " اقتباس');
  const videos = parseContent(data([{ playlistVideoRenderer: { videoId: 'aaaaaaaaaaa', title: { simpleText: 'حلقة' } } }, { playlistVideoRenderer: { videoId: 'bbbbbbbbbbb', title: { simpleText: 'خاص' }, isPlayable: false } }]), 'videos');
  assert.equal(videos.items.length, 1);
  assert.throws(() => initialData('<html>Consent page</html>'), /unavailable/);
});
test('YouTube combines both channels, paginates videos, refreshes new content and restricts playback to indexed entries', async () => {
  let clock = 1000, version = 1, reads = 0;
  const read = async (url, body) => {
    reads++;
    if (url.includes('@NoraDrama')) return html([item(playlistA, 'المسلسل الأول'), ...(version > 1 ? [item(playlistC, 'قائمة جديدة')] : [])]);
    if (url.includes('@ISHRAQ_Production')) return html([item(playlistB, 'برنامج إشراق')]);
    if (body) {
      assert.equal(body.context.client.clientVersion, 'test-version');
      assert.equal(body.continuation, 'next-page');
      return { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [item('bbbbbbbbbbb', 'الحلقة الثانية', 'VIDEO'), ...(version > 1 ? [item('ccccccccccc', 'الحلقة الثالثة', 'VIDEO')] : [])] } }] };
    }
    return html([item('aaaaaaaaaaa', 'الحلقة الأولى', 'VIDEO'), { continuationItemViewModel: { continuationCommand: { innertubeCommand: { continuationCommand: { token: 'next-page' } } } } }]);
  };
  const p = createYouTubeProvider(read, () => clock);
  const all = await p.catalog('series');
  assert.equal(all.length, 2);
  assert.equal((await p.catalog('series', { search: 'اشراق' })).length, 1);
  assert.deepEqual(await p.catalog('movie'), []);
  assert.deepEqual(await p.catalog('series', { skip: 100 }), []);
  const page = await p.detail('series', `noradrama:${playlistA}`);
  assert.equal(page.meta.videos.length, 2);
  const streams = await p.streams('series', page.meta.videos[0].id);
  assert.equal(streams[0].externalUrl, `https://www.youtube.com/watch?v=aaaaaaaaaaa&list=${playlistA}`);
  assert.equal(streams[1].externalUrl, `/open/tizentube/aaaaaaaaaaa/${playlistA}`);
  assert.equal(streams[0].url, undefined);
  assert.deepEqual(await p.streams('series', `noradrama:${playlistA}:1:zzzzzzzzzzz`), []);
  const before = reads;
  assert.equal(await p.detail('series', 'https://evil.example'), null);
  assert.equal(await p.detail('series', `noradrama:PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`), null);
  assert.equal(reads, before);
  version = 2; clock += 1800001;
  assert.equal((await p.catalog('series')).length, 3);
  assert.equal((await p.detail('series', `noradrama:${playlistA}`)).meta.videos.length, 3);
});
test('YouTube transient upstream failure keeps the last successful combined catalog', async () => {
  let clock = 0, fail = false;
  const p = createYouTubeProvider(async () => {
    if (fail) throw new Error('Temporary upstream failure');
    return html([item(playlistA, 'قائمة موجودة')]);
  }, () => clock);
  const first = await p.catalog('series');
  fail = true; clock += 1800001;
  assert.deepEqual(await p.catalog('series'), first);
});
