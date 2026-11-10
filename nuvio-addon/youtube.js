'use strict';
const cheerio = require('cheerio');
const { normalize } = require('./kawthar');
const CHANNELS = [{ handle: 'NoraDrama', name: 'نورا دراما' }, { handle: 'ISHRAQ_Production', name: 'إشراق' }];
const PREFIX = 'noradrama:';
const PLAYLIST = /^[A-Za-z0-9_-]{10,80}$/;
const VIDEO = /^[A-Za-z0-9_-]{11}$/;
function initialData(html) {
  const $ = cheerio.load(html);
  for (const el of $('script').toArray()) {
    const script = $(el).html() || '';
    const m = /(?:var\s+ytInitialData|window\["ytInitialData"\]|ytInitialData)\s*=\s*/.exec(script);
    if (!m) continue;
    const start = script.indexOf('{', m.index + m[0].length);
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i >= 0 && i < script.length; i++) {
      const c = script[i];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
      else if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return JSON.parse(script.slice(start, i + 1));
    }
  }
  throw new Error('YouTube public page data unavailable');
}
function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  for (const v of Object.values(value)) walk(v, visit);
}
function text(value) { return value?.content || value?.simpleText || value?.runs?.map(x => x.text).join('') || ''; }
function thumbnail(value) {
  let images = [];
  walk(value, x => {
    if (Array.isArray(x.sources)) images.push(...x.sources);
    if (Array.isArray(x.thumbnails)) images.push(...x.thumbnails);
  });
  images = images.filter(x => { try { const u = new URL(x.url); return u.protocol === 'https:' && ['i.ytimg.com', 'img.youtube.com', 'yt3.ggpht.com', 'yt3.googleusercontent.com'].includes(u.hostname); } catch { return false; } });
  return images.sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url;
}
function contentRoot(data) {
  const browse = data.contents?.twoColumnBrowseResultsRenderer || data.contents?.singleColumnBrowseResultsRenderer;
  if (browse) return browse.tabs?.find(x => x.tabRenderer?.selected)?.tabRenderer.content || {};
  return data.onResponseReceivedActions || data.onResponseReceivedEndpoints || data.continuationContents || {};
}
function parseContent(data, kind) {
  const items = new Map(), tokens = new Set();
  walk(contentRoot(data), node => {
    const modern = node.lockupViewModel;
    if (modern?.contentType === (kind === 'playlists' ? 'LOCKUP_CONTENT_TYPE_PLAYLIST' : 'LOCKUP_CONTENT_TYPE_VIDEO')) {
      const id = modern.contentId, name = text(modern.metadata?.lockupMetadataViewModel?.title);
      if ((kind === 'playlists' ? PLAYLIST : VIDEO).test(id || '') && name) items.set(id, { key: id, name, poster: thumbnail(modern.contentImage) });
    }
    const old = kind === 'playlists' ? node.gridPlaylistRenderer || node.playlistRenderer : node.playlistVideoRenderer;
    if (old && old.isPlayable !== false) {
      const id = kind === 'playlists' ? old.playlistId : old.videoId, name = text(old.title);
      if ((kind === 'playlists' ? PLAYLIST : VIDEO).test(id || '') && name) items.set(id, { key: id, name, poster: thumbnail(old.thumbnail) });
    }
    const token = node.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token || node.continuationItemViewModel?.continuationCommand?.innertubeCommand?.continuationCommand?.token;
    if (token) tokens.add(token);
  });
  return { items: [...items.values()], tokens: [...tokens] };
}
async function request(url, body) {
  const u = new URL(url);
  if (u.origin !== 'https://www.youtube.com') throw new Error('Invalid YouTube upstream');
  const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ar,en;q=0.8' };
  if (body) { headers['Content-Type'] = 'application/json'; headers['X-Youtube-Client-Name'] = '1'; headers['X-Youtube-Client-Version'] = body.context.client.clientVersion; }
  const r = await fetch(u, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  if (!r.ok || new URL(r.url).hostname !== 'www.youtube.com') throw new Error(`YouTube public page HTTP ${r.status}`);
  return body ? r.json() : r.text();
}
function createYouTubeProvider(read = request, now = Date.now) {
  const cache = new Map();
  async function cached(key, work) {
    const previous = cache.get(key);
    if (previous?.until > now()) return previous.promise;
    const entry = { until: now() + 1800000 };
    entry.promise = work().then(value => { entry.value = value; return value; }).catch(e => {
      if (previous?.value) { entry.value = previous.value; entry.until = now() + 300000; console.error('YouTube content refresh kept the previous index:', e.message); return previous.value; }
      cache.delete(key); throw e;
    });
    if (cache.size > 150) cache.delete(cache.keys().next().value);
    cache.set(key, entry); return entry.promise;
  }
  async function browse(url, kind) {
    const html = await read(url), data = initialData(html), parsed = parseContent(data, kind);
    const items = new Map(parsed.items.map(x => [x.key, x])), pending = [...parsed.tokens], seen = new Set();
    const version = /"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/.exec(html)?.[1];
    while (pending.length) {
      const continuation = pending.shift(); if (seen.has(continuation)) continue;
      if (seen.size >= 100) throw new Error('YouTube playlist pagination limit');
      if (!version) throw new Error('YouTube public browser configuration unavailable');
      seen.add(continuation);
      const result = await read('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', { context: { client: { clientName: 'WEB', clientVersion: version, hl: 'ar', gl: 'US' } }, continuation });
      if (result.error) throw new Error('YouTube continuation unavailable');
      const next = parseContent(result, kind);
      for (const item of next.items) items.set(item.key, item);
      pending.push(...next.tokens.filter(x => !seen.has(x)));
    }
    return { items: [...items.values()], title: data.metadata?.playlistMetadataRenderer?.title };
  }
  async function index() {
    return cached('catalog', async () => {
      const results = await Promise.all(CHANNELS.map(async channel => {
        const result = await browse(`https://www.youtube.com/@${channel.handle}/playlists?hl=ar`, 'playlists');
        if (!result.items.length) throw new Error(`No public playlists returned for ${channel.handle}`);
        return result.items.map(x => ({ ...x, channel: channel.name }));
      }));
      return [...new Map(results.flat().map(x => [x.key, x])).values()];
    });
  }
  function parse(type, id) { return type === 'series' && id.startsWith(PREFIX) ? /^([A-Za-z0-9_-]{10,80})(?::1:([A-Za-z0-9_-]{11}))?$/.exec(id.slice(PREFIX.length)) : null; }
  function meta(item) { return { id: PREFIX + item.key, type: 'series', name: item.name, poster: item.poster, posterShape: 'landscape', description: `${item.channel}\nقائمة تشغيل عامة من YouTube. المشاهدة عبر تطبيق أو موقع YouTube.`, website: `https://www.youtube.com/playlist?list=${item.key}`, language: 'العربية' }; }
  async function detail(type, id) {
    const m = parse(type, id); if (!m || m[2]) return null;
    const item = (await index()).find(x => x.key === m[1]); if (!item) return null;
    const result = await cached(`playlist:${m[1]}`, () => browse(`https://www.youtube.com/playlist?list=${m[1]}&hl=ar`, 'videos'));
    return { meta: { ...meta(item), videos: result.items.map((video, i) => ({ id: `${id}:1:${video.key}`, title: video.name, season: 1, episode: i + 1, thumbnail: video.poster || `https://i.ytimg.com/vi/${video.key}/hqdefault.jpg` })) }, items: result.items };
  }
  return {
    async catalog(type, extra = {}) {
      if (type !== 'series') return [];
      const search = normalize(extra.search), skip = Math.max(0, Number(extra.skip) || 0);
      return (await index()).filter(x => !search || normalize(`${x.name} ${x.channel}`).includes(search)).slice(skip, skip + 100).map(meta);
    },
    detail,
    async streams(type, id) {
      const m = parse(type, id); if (!m || !m[2]) return [];
      const page = await detail(type, PREFIX + m[1]);
      if (!page?.items.some(x => x.key === m[2])) return [];
      return [
        { name: 'YouTube', title: 'فتح في YouTube', externalUrl: `https://www.youtube.com/watch?v=${m[2]}&list=${m[1]}` },
        { name: 'TizenTubeCobalt', title: 'فتح في TizenTubeCobalt', externalUrl: `/open/tizentube/${m[2]}/${m[1]}` },
      ];
    },
  };
}
module.exports = { createYouTubeProvider, initialData, parseContent };
