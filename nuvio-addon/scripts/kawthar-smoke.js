const assert = require('node:assert/strict');
const { createKawtharProvider } = require('../kawthar');
const provider = createKawtharProvider();
async function check(type, id, episode) {
  const detail = await provider.detail(type, id);
  const video = type === 'series' ? detail.meta.videos.find(v => !episode || v.episode === episode) : { id };
  assert.ok(video, `Missing episode: ${id}`);
  const streams = await provider.streams(type, video.id);
  assert.ok(streams.length, `Missing stream: ${video.id}`);
  const r = await fetch(streams[0].url, { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(30000) });
  assert.ok(r.ok, `Media HTTP ${r.status}: ${streams[0].url}`);
  const reader = r.body.getReader();
  const bytes = new Uint8Array((await reader.read()).value);
  await reader.cancel();
  assert.ok(bytes.length > 0);
  if (/\.mpd$/.test(streams[0].url)) assert.match(new TextDecoder().decode(bytes), /MPD|xml/);
  else assert.match(r.headers.get('content-type'), /video|octet-stream/);
  console.log(`${detail.meta.name}: ${detail.meta.videos?.length || 0} episodes; playback HTTP ${r.status} ${streams[0].title}`);
}
(async () => {
  for (const type of ['series', 'movie']) {
    const items = await provider.catalog(type);
    assert.ok(items.length);
    const found = await provider.catalog(type, { search: items.at(-1).name });
    assert.ok(found.some(x => x.id === items.at(-1).id));
    console.log(`${type}: ${items.length} catalog entries; search OK`);
  }
  await check('series', 'kawthar:series:337676', 1);
  await check('series', 'kawthar:series:337676', 34);
  await check('series', 'kawthar:series:326404', 1);
  await check('movie', 'kawthar:movie:330258');
})().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
