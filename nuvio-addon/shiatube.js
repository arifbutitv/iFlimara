'use strict';
const cheerio = require('cheerio');
const crypto = require('node:crypto');
const BASE = 'https://shiatube.org';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'ar' };
const normalize = text => text.normalize('NFKC').replace(/[\u064B-\u065F\u0670\u200B-\u200F\u2063]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/\s+/g, ' ').trim().toLowerCase();
const digitize = text => text.replace(/[٠-٩]/g, x => String('٠١٢٣٤٥٦٧٨٩'.indexOf(x))).replace(/[۰-۹]/g, x => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(x)));
function parseVideos(html, channel) {
  const $ = cheerio.load(html), result = [];
  $('.video-wrapper').each((_, el) => {
    const card = $(el), a = card.find('.video-title a').first();
    const href = a.attr('href') || card.find('a[href*="/watch/"]').first().attr('href');
    if (!href) return;
    const watch = new URL(href, BASE);
    if (watch.origin !== BASE || !watch.pathname.startsWith('/watch/')) return;
    const path = watch.pathname;
    const id = /(?:_|\/)([A-Za-z0-9]{10,40})(?:\.html)?$/.exec(path)?.[1];
    const owner = card.find('.video-info a[href*="/@"]').first().attr('href');
    if (!id || (owner && new URL(owner, BASE).pathname !== `/@${channel}`)) return;
    const title = card.find('h4').first().attr('title') || a.text().trim();
    if (!title) return;
    result.push({ id, title, url: new URL(href, BASE).href, poster: card.find('img').first().attr('src'), description: card.find('.descc').text().trim(), cursor: card.attr('data-id'), views: card.attr('data-views') || '0' });
  });
  return result;
}
async function channelPage(channel) {
  const response = await fetch(`${BASE}/@${channel}`, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`ShiaTube channel HTTP ${response.status}`);
  const html = await response.text(), $ = cheerio.load(html);
  const cookie = response.headers.getSetCookie().map(x => x.split(';')[0]).join('; ');
  return { videos: parseVideos(html, channel), hash: $('.main_session').val(), user: $('#profile-id').val(), cookie };
}
async function syncChannel(channel, onPage = () => {}, existing = []) {
  const page = await channelPage(channel), all = new Map([...page.videos, ...existing].map(x => [x.id, x]));
  let last = [...all.values()].at(-1);
  onPage([...all.values()]);
  if (!page.hash || !page.user) throw new Error('ShiaTube session data missing');
  for (let n = 0; n < 1000 && last; n++) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const body = new URLSearchParams({ hash: page.hash, user_id: page.user, last_id: last.cursor, keyword: '', date: '', category: '', sort_type: '', sort_by: '', paid_sort: '' });
    const response = await fetch(`${BASE}/aj/load-more/profile_videos?views=${encodeURIComponent(last.views)}`, { method: 'POST', body, headers: { ...HEADERS, Cookie: page.cookie, Referer: `${BASE}/@${channel}`, 'X-Requested-With': 'XMLHttpRequest' }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`ShiaTube pagination HTTP ${response.status}`);
    const data = await response.json();
    if (Array.isArray(data) && data.length === 0) return [...all.values()];
    if (data.status !== 200) throw new Error(`ShiaTube pagination response ${JSON.stringify(data).slice(0, 200)}`);
    const videos = parseVideos(data.videos || data.html || '', channel);
    let added = 0;
    for (const video of videos) if (!all.has(video.id)) { all.set(video.id, video); added++; }
    if (!added) return [...all.values()];
    last = videos.at(-1);
    onPage([...all.values()]);
  }
  throw new Error('Channel pagination did not reach its end');
}
function groupSeries(videos) {
  const groups = new Map();
  for (const video of videos) {
    const text = digitize(video.title);
    const match = /(?:الحلقة|حلقه|حلقة|حلقه|episode)\s*[:\-–]?\s*(\d+)/i.exec(text);
    const name = (match ? text.slice(0, match.index) : text).replace(/[\s\-–:]+$/, '').trim();
    const key = crypto.createHash('sha256').update(normalize(name)).digest('hex').slice(0, 20);
    if (!groups.has(key)) groups.set(key, { key, name, poster: video.poster, description: video.description, episodes: [] });
    groups.get(key).episodes.push({ ...video, number: match ? Number(match[1]) : 1 });
  }
  for (const group of groups.values()) group.episodes.sort((a, b) => a.number - b.number);
  return [...groups.values()];
}
function createShiaProvider(snapshot, options = {}) {
  const lists = { series: [...(snapshot.series || [])], movies: [...(snapshot.movies || [])] };
  let refreshed = 0, refreshJob;
  async function refresh() {
    if (options.refresh === false || Date.now() - refreshed < 600000) return;
    if (!refreshJob) refreshJob = Promise.allSettled(['series', 'movies'].map(async channel => {
      const page = await channelPage(channel);
      const merged = new Map(page.videos.map(x => [x.id, x]));
      for (const video of lists[channel]) if (!merged.has(video.id)) merged.set(video.id, video);
      lists[channel] = [...merged.values()];
    })).then(results => {
      for (const r of results) if (r.status === 'rejected') console.error('ShiaTube refresh:', r.reason.message);
      refreshed = Date.now(); refreshJob = undefined;
    });
    await refreshJob;
  }
  function groups() { return groupSeries(lists.series); }
  async function catalog(type, extra = {}) {
    await refresh();
    const entries = type === 'series' ? groups().map(g => ({ id: `shiatube:series:${g.key}`, type, name: g.name, poster: g.poster, description: g.description, posterShape: 'landscape' })) : lists.movies.map(v => ({ id: `shiatube:movie:${v.id}`, type, name: v.title, poster: v.poster, description: v.description, posterShape: 'landscape' }));
    const search = normalize(extra.search || '');
    const skip = Math.max(0, Math.trunc(Number(extra.skip) || 0));
    return entries.filter(x => !search || normalize(x.name).includes(search)).slice(skip, skip + 100);
  }
  function detail(type, id) {
    if (type === 'movie') {
      const video = lists.movies.find(v => id === `shiatube:movie:${v.id}`);
      return video ? { meta: { id, type, name: video.title, poster: video.poster, background: video.poster, description: video.description, website: video.url, posterShape: 'landscape' } } : null;
    }
    const group = groups().find(g => id === `shiatube:series:${g.key}`);
    return group ? { meta: { id, type, name: group.name, poster: group.poster, background: group.poster, description: group.description, posterShape: 'landscape', videos: group.episodes.map(v => ({ id: `${id}:1:${v.id}`, season: 1, episode: v.number, title: `الحلقة ${v.number}`, thumbnail: v.poster, available: true })) } } : null;
  }
  function videoFor(type, id) {
    if (type === 'movie') return lists.movies.find(v => id === `shiatube:movie:${v.id}`);
    const match = /^shiatube:series:([a-f0-9]{20}):1:([A-Za-z0-9]+)$/.exec(id);
    const group = match && groups().find(g => g.key === match[1]);
    return group?.episodes.find(v => v.id === match[2]);
  }
  async function streams(type, id) {
    const video = videoFor(type, id);
    if (!video) return [];
    return [{ name: 'ShiaTube', title: 'MP4 — تشغيل مباشر', url: `/shiatube/play/${video.id}.mp4`, behaviorHints: { notWebReady: false, bingeGroup: 'shiatube-mp4', filename: `${video.id}.mp4` } }];
  }
  return { catalog, detail, streams, findVideo: id => [...lists.movies, ...lists.series].find(v => v.id === id) };
}
const mediaCache = new Map();
async function resolveVideo(video) {
  if (new URL(video.url).origin !== BASE) throw new Error('Invalid watch destination');
  if (mediaCache.get(video.id)?.expires > Date.now()) return mediaCache.get(video.id).url;
  const r = await fetch(video.url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`ShiaTube watch HTTP ${r.status}`);
  const $ = cheerio.load(await r.text());
  let source = $('video source[src]').first().attr('src') || $('a[download]').first().attr('href');
  if (!source) {
    const iframe = $('.pt_vdo_plyr iframe').first().attr('src');
    const url = iframe && new URL(iframe, BASE);
    if (!url || !['ok.ru', 'www.ok.ru'].includes(url.hostname) || !/^\/videoembed\/\d+$/.test(url.pathname)) throw new Error('No supported public video source');
    const embed = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (!embed.ok) throw new Error(`Video player HTTP ${embed.status}`);
    const player = cheerio.load(await embed.text());
    for (const el of player('[data-options]').toArray()) {
      const options = JSON.parse(player(el).attr('data-options'));
      let metadata = options.flashvars?.metadata;
      if (typeof metadata === 'string') metadata = JSON.parse(metadata);
      const order = { full: 5, hd: 4, sd: 3, low: 2, lowest: 1 };
      const sources = (metadata?.videos || []).filter(v => !v.disallowed && v.url).sort((a, b) => (order[b.name] || 0) - (order[a.name] || 0));
      if (sources[0]) { source = sources[0].url; break; }
    }
  }
  if (!source) throw new Error('No playable MP4 source');
  let url = new URL(source, BASE);
  if (url.hostname === 'preview.presstv.ir') url = new URL(url.pathname.replace(/^\/ifilm\//, ''), 'https://preview.presstv.co.uk/ifilm/');
  if (!allowedMedia(url)) throw new Error('Unsupported media host');
  const value = url.href;
  if (mediaCache.size >= 200) mediaCache.delete(mediaCache.keys().next().value);
  mediaCache.set(video.id, { url: value, expires: Date.now() + 120000 });
  return value;
}
function allowedMedia(url) {
  return url.protocol === 'https:' && (url.hostname === 'shiatube.org' || url.hostname.endsWith('.b-cdn.net') || url.hostname.endsWith('.okcdn.ru') || url.hostname === 'preview.presstv.co.uk' || url.hostname.endsWith('.ifilmtv.ir'));
}
module.exports = { parseVideos, groupSeries, createShiaProvider, syncChannel, resolveVideo, allowedMedia, normalize, UA };
