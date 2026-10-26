'use strict';
const cheerio = require('cheerio');
const crypto = require('node:crypto');
const savedSources = require('./data/shiatube-sources.json');
const { readRemoteContent } = require('./remote-content');
const initialState = require('./data/shiatube-state.json');
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
function mergeNewVideos(existing, incoming) {
  const known = new Set(existing.map(v => v.id));
  const added = incoming.filter(v => !known.has(v.id));
  return added.length ? [...added, ...existing] : existing;
}
async function syncRecentChannel(channel, existing) {
  const page = await channelPage(channel), known = new Set(existing.map(v => v.id));
  const incoming = new Map(page.videos.map(v => [v.id, v]));
  let batch = page.videos;
  for (let n = 0; batch.length && !batch.some(v => known.has(v.id)); n++) {
    if (n >= 200) throw new Error('Recent channel pagination limit reached');
    const last = batch.at(-1);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const r = await fetch(`${BASE}/aj/load-more/profile_videos?views=${encodeURIComponent(last.views)}`, {
      method: 'POST', body: new URLSearchParams({ hash: page.hash, user_id: page.user, last_id: last.cursor }),
      headers: { ...HEADERS, Cookie: page.cookie, Referer: `${BASE}/@${channel}`, 'X-Requested-With': 'XMLHttpRequest' }, signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`Recent channel HTTP ${r.status}`);
    const data = await r.json();
    if (Array.isArray(data) && !data.length) break;
    if (data.status !== 200) throw new Error('Invalid recent channel response');
    batch = parseVideos(data.videos || data.html || '', channel);
    let added = 0;
    for (const video of batch) if (!incoming.has(video.id)) { incoming.set(video.id, video); added++; }
    if (!added) break;
  }
  return mergeNewVideos(existing, [...incoming.values()]);
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
  let state = initialState;
  async function refresh() {
    if (options.refresh === false || Date.now() - refreshed < 600000) return;
    if (!refreshJob) refreshJob = (async () => {
      try {
        const result = await (options.readRemote || readRemoteContent)(state.revision);
        if (result) {
          Object.assign(savedSources, result.sources);
          lists.series = result.snapshot.series;
          lists.movies = result.snapshot.movies;
          state = result.state;
          mediaCache.clear();
        }
      } catch (error) { console.error('Content refresh kept the current index:', error.message); }
      finally { refreshed = Date.now(); refreshJob = undefined; }
    })();
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
    return group ? { meta: { id, type, name: group.name, poster: group.poster, background: group.poster, description: group.description, posterShape: 'landscape', videos: group.episodes.map(v => ({ id: `${id}:1:${v.id}`, season: 1, episode: v.number, title: `الحلقة ${v.number}`, thumbnail: v.poster, available: !savedSources[v.id]?.unavailable })) } } : null;
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
    const hint = savedSources[video.id];
    if (hint?.unavailable) return [];
    if (!hint?.source && hint?.iframe) {
      const frame = new URL(hint.iframe, BASE);
      if (['www.dailymotion.com', 'dailymotion.com', 'www.youtube.com', 'youtube.com'].includes(frame.hostname)) return [{ name: 'ShiaTube', title: 'فتح المصدر الخارجي', externalUrl: frame.href }];
    }
    let direct;
    if (hint?.source) {
      try { direct = canonicalMedia(hint.source).href; }
      catch {
        const url = new URL(hint.source, BASE);
        if (!hint.iframe && ['youtube.com', 'www.youtube.com', 'youtu.be', 'dailymotion.com', 'www.dailymotion.com'].includes(url.hostname)) return [{ name: 'ShiaTube', title: 'فتح المصدر الخارجي', externalUrl: url.href }];
        if (!hint.iframe) return [];
      }
    }
    const hls = direct?.includes('.m3u8') || false;
    return [{ name: 'ShiaTube', title: hls ? 'HLS — جودة تلقائية' : 'MP4 — تشغيل مباشر', url: direct || `/shiatube/play/${video.id}.mp4`, behaviorHints: { notWebReady: hls, bingeGroup: `shiatube-${hls ? 'hls' : 'mp4'}`, filename: `${video.id}.${hls ? 'm3u8' : 'mp4'}` } }];
  }
  return { catalog, detail, streams, contentState: () => ({ revision: state.revision, updated: state.updated, series: lists.series.length, movies: lists.movies.length }), findVideo: id => [...lists.movies, ...lists.series].find(v => v.id === id) };
}
const mediaCache = new Map();
function playbackError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function parsePlayer(html) {
  const $ = cheerio.load(html);
  const scripted = /\$\(['"]video['"]\)\.attr\(['"]src['"]\s*,\s*['"]([^'"]+)['"]\)/.exec(html)?.[1];
  return {
    unavailable: $('.video-processing').length > 0,
    source: $('video source[src]').first().attr('src') || $('video[src]').first().attr('src') || $('a[download]').first().attr('href') || scripted,
    iframe: $('.pt_vdo_plyr iframe').first().attr('src') || $('iframe[src*="ok.ru/videoembed/"]').first().attr('src'),
  };
}
async function resolveVideo(video, get = fetch) {
  if (new URL(video.url).origin !== BASE) throw new Error('Invalid watch destination');
  if (mediaCache.get(video.id)?.expires > Date.now()) return mediaCache.get(video.id).url;
  let playerData = savedSources[video.id], lastError;
  if (playerData?.unavailable) throw playbackError('SOURCE_UNAVAILABLE', 'Video is unavailable on ShiaTube');
  for (const target of playerData ? [] : [video.url, `${BASE}/embed/${video.id}`]) {
    try {
      const r = await get(target, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw playbackError(`SHIATUBE_HTTP_${r.status}`, `ShiaTube page HTTP ${r.status}`);
      const parsed = parsePlayer(await r.text());
      if (parsed.source || parsed.iframe) { playerData = parsed; break; }
      throw playbackError('SHIATUBE_NO_PLAYER', 'ShiaTube page has no supported player');
    } catch (error) { lastError = error; }
  }
  if (!playerData) throw lastError || playbackError('SHIATUBE_UNAVAILABLE', 'ShiaTube unavailable');
  let source = playerData.source;
  if (source && playerData.iframe) {
    try { canonicalMedia(source); } catch { source = undefined; }
  }
  if (!source) {
    const iframe = playerData.iframe;
    const url = iframe && new URL(iframe, BASE);
    if (!url || !['ok.ru', 'www.ok.ru'].includes(url.hostname) || !/^\/videoembed\/\d+$/.test(url.pathname)) throw new Error('No supported public video source');
    const embed = await get(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (!embed.ok) throw playbackError(`OK_PLAYER_HTTP_${embed.status}`, `Video player HTTP ${embed.status}`);
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
  const url = canonicalMedia(source);
  const value = url.href;
  if (mediaCache.size >= 200) mediaCache.delete(mediaCache.keys().next().value);
  mediaCache.set(video.id, { url: value, expires: Date.now() + 120000 });
  return value;
}
function canonicalMedia(source) {
  let url = new URL(source, BASE);
  if (url.hostname === 'preview.presstv.ir') url = new URL(url.pathname.replace(/^\/ifilm\//, ''), 'https://preview.presstv.co.uk/ifilm/');
  if (url.hostname.endsWith('.ifilmtv.ir')) {
    const path = url.pathname.replace(/^\/+/, '').replace(/^ifilm\//, '');
    if (/^UploadedFiles\/Video\//i.test(path)) url = new URL(path, 'https://preview.presstv.co.uk/ifilm/');
  }
  if (!allowedMedia(url)) throw new Error('Unsupported media host');
  return url;
}
function allowedMedia(url) {
  return url.protocol === 'https:' && (url.hostname === 'shiatube.org' || url.hostname.endsWith('.b-cdn.net') || url.hostname.endsWith('.okcdn.ru') || url.hostname === 'preview.presstv.co.uk' || url.hostname.endsWith('.ifilmtv.ir') || url.hostname.endsWith('.archive.org') || url.hostname === 'video.alkawthartv.ir');
}
module.exports = { parseVideos, groupSeries, createShiaProvider, syncChannel, syncRecentChannel, mergeNewVideos, resolveVideo, allowedMedia, normalize, UA, parsePlayer };
