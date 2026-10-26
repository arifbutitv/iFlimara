const fs = require('node:fs');
const path = require('node:path');
const { parsePlayer, groupSeries, UA } = require('../shiatube');
const snapshot = require('../data/shiatube.json');
const filename = path.join(__dirname, '../data/shiatube-sources.json');
const sources = JSON.parse(fs.readFileSync(filename));
let requests = 0, failures = 0;
let nextSlot = Date.now();
const pending = new Map();
const checkedUnavailable = new Set();
async function load(video) {
  if (sources[video.id] && (!sources[video.id].unavailable || checkedUnavailable.has(video.id))) return sources[video.id];
  if (pending.has(video.id)) return pending.get(video.id);
  const promise = (async () => {
    const slot = nextSlot;
    nextSlot = Math.max(Date.now(), nextSlot) + 600;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, slot - Date.now())));
    const r = await fetch(video.url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`Watch HTTP ${r.status} for ${video.id}`);
    requests++;
    const player = parsePlayer(await r.text());
    if (!player.source && !player.iframe && !player.unavailable) throw new Error(`No player for ${video.id}`);
    sources[video.id] = player;
    if (player.unavailable) checkedUnavailable.add(video.id);
    fs.writeFileSync(filename, JSON.stringify(sources));
    return player;
  })();
  pending.set(video.id, promise);
  try { return await promise; } finally { pending.delete(video.id); }
}
function serialPath(player, number) {
  if (!player.source) return null;
  const u = new URL(player.source, 'https://shiatube.org');
  if (u.hostname === 'vod.ifilmtv.ir') {
    const hls = /^\/hls\/(ar\d+)\/,(\d+),/.exec(u.pathname);
    return hls && Number(hls[2]) === number ? hls[1] : null;
  }
  if (!['preview.presstv.ir', 'preview.presstv.co.uk'].includes(u.hostname)) return null;
  const m = /^\/ifilm\/(ar\d+)\/(\d+)\.mp4$/.exec(u.pathname);
  return m && Number(m[2]) === number ? m[1] : null;
}
async function series(group) {
  const first = group.episodes[0], last = group.episodes.at(-1);
  try {
    await load(first); await load(last);
    const roots = new Map();
    const samples = [...new Set([first, last, group.episodes[Math.floor(group.episodes.length / 2)]])];
    for (const ep of samples) {
      const root = serialPath(await load(ep), ep.number);
      if (root) { if (!roots.has(root)) roots.set(root, new Set()); roots.get(root).add(ep.number); }
    }
    const root = [...roots].find(([, numbers]) => numbers.size >= Math.min(2, group.episodes.length))?.[0];
    if (root && roots.size === 1) {
      // Both ends of the series explicitly publish the same numbered VOD path.
      for (const ep of group.episodes) if (!sources[ep.id] || /(?:youtube\.com|youtu\.be)/.test(sources[ep.id].source || '')) sources[ep.id] = { source: `https://preview.presstv.co.uk/ifilm/${root}/${ep.number}.mp4` };
      fs.writeFileSync(filename, JSON.stringify(sources));
    } else {
      for (const ep of group.episodes) await load(ep);
    }
  } catch (error) { failures++; console.error(error.message); }
}
async function runPool(tasks) {
  let next = 0;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      await task();
      if (next % 20 === 0) console.log(`Tasks ${next}/${tasks.length}; indexed ${Object.keys(sources).length}; requests ${requests}; errors ${failures}`);
    }
  }));
}
(async () => {
  const tasks = groupSeries(snapshot.series).map(g => () => series(g));
  tasks.push(...snapshot.movies.map(v => async () => { try { await load(v); } catch (error) { failures++; console.error(error.message); } }));
  await runPool(tasks);
  const missing = [...snapshot.series, ...snapshot.movies].filter(v => !sources[v.id]);
  console.log(`Indexed ${Object.keys(sources).length}; missing ${missing.length}; requests ${requests}`);
  if (missing.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
