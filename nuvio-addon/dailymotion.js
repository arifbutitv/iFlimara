'use strict';
const { normalize } = require('./kawthar');
const API = 'https://api.dailymotion.com';
const PREFIX = 'dailymotion:';
async function request(path) {
  const url = new URL(path, API);
  if (url.origin !== API) throw new Error('Invalid Dailymotion upstream');
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Dailymotion HTTP ${response.status}`);
  return response.json();
}
function episodeNumber(title) {
  const text = String(title).replace(/[٠-٩۰-۹]/g, c => String(c.charCodeAt(0) - (c >= '۰' ? 1776 : 1632)));
  const match = /(?:الحلقة|حلقة|episode)\s*[:\-–]?\s*(\d+)/i.exec(text);
  return match ? Number(match[1]) : undefined;
}
function createDailymotionProvider(read = request, now = Date.now) {
  const cache = new Map();
  async function cached(key, work) {
    const previous = cache.get(key);
    if (previous?.until > now()) return previous.promise;
    const entry = { until: now() + 1800000 };
    entry.promise = work().then(value => { entry.value = value; return value; }).catch(error => {
      if (previous?.value) {
        entry.value = previous.value;
        entry.until = now() + 300000;
        console.error('Dailymotion refresh kept previous data:', error.message);
        return previous.value;
      }
      cache.delete(key);
      throw error;
    });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    cache.set(key, entry);
    return entry.promise;
  }
  async function pages(path, fields) {
    const found = new Map();
    for (let page = 1; page <= 100; page++) {
      const result = await read(`${path}?${new URLSearchParams({ fields, limit: '100', page: String(page) })}`);
      if (result.error || !Array.isArray(result.list)) throw new Error('Invalid Dailymotion response');
      for (const item of result.list) if (/^[A-Za-z0-9]+$/.test(item.id || '')) found.set(item.id, item);
      if (!result.has_more) return [...found.values()];
    }
    throw new Error('Dailymotion pagination limit');
  }
  const index = () => cached('catalog', () => pages('/user/ifilm.tvchannel/playlists', 'id,name,description,thumbnail_url'));
  function meta(item) {
    return { id: PREFIX + item.id, type: 'series', name: item.name, description: item.description || undefined, poster: item.thumbnail_url, posterShape: 'landscape', website: `https://www.dailymotion.com/playlist/${item.id}`, language: 'العربية' };
  }
  function parse(type, id) {
    return type === 'series' ? /^dailymotion:([A-Za-z0-9]+)(?::1:([A-Za-z0-9]+))?$/.exec(id) : null;
  }
  async function detail(type, id) {
    const match = parse(type, id);
    if (!match || match[2]) return null;
    const item = (await index()).find(x => x.id === match[1]);
    if (!item) return null;
    const videos = await cached(`playlist:${item.id}`, () => pages(`/playlist/${item.id}/videos`, 'id,title,thumbnail_url'));
    const numbered = videos.map(video => ({ ...video, number: episodeNumber(video.title) }));
    if (numbered.every(video => Number.isInteger(video.number) && video.number > 0)) numbered.sort((a, b) => a.number - b.number);
    return { meta: { ...meta(item), videos: numbered.map((video, i) => ({ id: `${id}:1:${video.id}`, title: video.title, season: 1, episode: video.number || i + 1, thumbnail: video.thumbnail_url })) }, videos };
  }
  return {
    async catalog(type, extra = {}) {
      if (type !== 'series') return [];
      const search = normalize(extra.search || '');
      const skip = Math.max(0, Math.trunc(Number(extra.skip) || 0));
      return (await index()).filter(x => x.name && (!search || normalize(x.name).includes(search))).slice(skip, skip + 100).map(meta);
    },
    detail,
    async streams(type, id) {
      const match = parse(type, id);
      if (!match?.[2]) return [];
      const page = await detail(type, PREFIX + match[1]);
      if (!page?.videos.some(x => x.id === match[2])) return [];
      return [{ name: 'Dailymotion', title: 'فتح في Dailymotion', externalUrl: `https://www.dailymotion.com/video/${match[2]}` }];
    },
  };
}
module.exports = { createDailymotionProvider };
