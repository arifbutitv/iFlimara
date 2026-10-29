const test = require('node:test');
const assert = require('node:assert/strict');
const { createProgramsProvider } = require('../programs');
test('iFilm programs catalog searches and paginates independently from series and movies', async () => {
  const p = createProgramsProvider('ifilm', async (path, json) => {
    assert.equal(json, true);
    assert.match(path, /category=7/);
    return Array.from({ length: 120 }, (_, i) => ({ Id: i + 1, Title: `برنامج ${i + 1}` }));
  });
  assert.equal((await p.catalog('series')).length, 100);
  assert.equal((await p.catalog('series', { skip: 100 })).length, 20);
  assert.equal((await p.catalog('series', { search: 'برنامج 120' }))[0].id, 'ifilmar-program:120');
  assert.deepEqual(await p.catalog('movie'), []);
});
test('iFilm programs use Program pages, stable episode IDs and original media resolution', async () => {
  const p = createProgramsProvider('ifilm', async (path, json) => {
    if (!json) { assert.equal(path, '/Program/Content/1'); return '<meta property="og:title" content="كواليس">'; }
    return path.includes('page=1&') ? [{ Episode: 1, VideoAddress: '/UploadedFiles/Video/test.mp4' }] : [];
  });
  const page = await p.detail('series', 'ifilmar-program:1');
  assert.equal(page.meta.website, 'https://ar.ifilmtv.ir/Program/Content/1');
  assert.equal(page.meta.videos[0].id, 'ifilmar-program:1:1:1');
  assert.match((await p.streams('series', page.meta.videos[0].id))[0].url, /preview.presstv.co.uk\/ifilm\/UploadedFiles\/Video\/test.mp4/);
});
test('Kawthar programs include dated, unnumbered episodes while excluding clips and unrelated entries', async () => {
  const p = createProgramsProvider('kawthar', async path => {
    if (path === '/programs') return '<a href="/epi/100"><h6 class="iq-title">قضية ساخنة</h6></a><a href="/news/999"><h6 class="iq-title">فيلم</h6></a>';
    if (path === '/epi/100') return '<meta property="og:title" content="قضية ساخنة"><div class="favourite-slider"><a href="/episode/20"><h6 class="iq-title">قضية ساخنة | 27-10-2026</h6></a><a href="/episode/10"><h6 class="iq-title">موضوع بلا رقم</h6></a></div><div class="favourite-slider"><a href="/episode/30"><h6 class="iq-title">مقطع</h6></a></div>';
    assert.equal(path, '/episode/10');
    return '<video src="https://cdn2.alkawthartv.ir/test.mp4"></video>';
  });
  assert.equal((await p.catalog('series', { search: 'قضية ساخنة' })).length, 1);
  const meta = (await p.detail('series', 'kawthar-program:100')).meta;
  assert.equal(meta.videos.length, 2);
  assert.equal(meta.videos[0].id, 'kawthar-program:100:1:10');
  assert.equal((await p.streams('series', meta.videos[0].id))[0].url, 'https://cdn2.alkawthartv.ir/test.mp4');
  assert.deepEqual(await p.streams('series', 'kawthar-program:100:1:30'), []);
  assert.deepEqual(await p.streams('series', 'kawthar:series:100:1:10'), []);
});
