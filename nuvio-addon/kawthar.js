'use strict';
const cheerio = require('cheerio');
const BASE = 'https://www.alkawthartv.ir';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';
const categories = { series: '629', movie: '628' };
const normalize = s => String(s || '').normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ی/g, 'ي').replace(/ک/g, 'ك').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
const digits = s => String(s).replace(/[٠-٩۰-۹]/g, c => String(c.charCodeAt(0) - (c >= '۰' ? 1776 : 1632)));
function absolute(value) { try { return value ? new URL(value, BASE).href : undefined; } catch { return undefined; } }
function mediaUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return undefined;
    if (!(u.hostname.endsWith('.alkawthartv.ir') || /^s\d+\.namasha\.com$/.test(u.hostname))) return undefined;
    return /\.(mp4|m3u8|mpd)$/i.test(u.pathname) ? u.href : undefined;
  } catch { return undefined; }
}
function parseCards(html, type, episodes = false) {
  const $ = cheerio.load(html), items = new Map();
  $('a[href]').each((_, el) => {
    const a = $(el), url = new URL(a.attr('href'), BASE);
    const match = /^\/(?:news|episode)\/(\d+)$/.exec(url.pathname);
    const title = a.find('h2.news-title, h6.iq-title').first().text().trim();
    if (url.origin !== BASE || !match || !title) return;
    const number = Number(/(?:الحلقة|حلقه)\s*[-:ـ]?\s*(\d+)/.exec(digits(title))?.[1]);
    if (episodes && !number) return;
    const image = a.find('img').first();
    items.set(match[1], { id: `kawthar:${type}:${match[1]}`, type, name: title, poster: absolute(image.attr('data-src') || image.attr('src')), posterShape: 'landscape', ...(episodes ? { number, key: match[1] } : {}) });
  });
  return [...items.values()];
}
function pageLinks(html, category) {
  const $ = cheerio.load(html);
  return [...new Set($('#PagerBottom a[href]').map((_, e) => {
    const u = new URL($(e).attr('href'), BASE);
    return u.origin === BASE && new RegExp(`^/category/${category}(?:/\\d+)?$`).test(u.pathname) ? u.pathname + u.search : null;
  }).get().filter(Boolean))];
}
function parsePage(html, type, key) {
  const $ = cheerio.load(html);
  const value = name => $(`meta[property="og:${name}"]`).attr('content')?.trim();
  const episodeLink = $('a[href]').filter((_, e) => $(e).find('h4.main-title').text().trim() === 'حلقات').first().attr('href');
  const category = episodeLink && /^\/category\/(\d+)/.exec(new URL(episodeLink, BASE).pathname)?.[1];
  return {
    meta: { id: `kawthar:${type}:${key}`, type, name: value('title') || $('h1').first().text().trim(), description: value('description'), poster: absolute(value('image')), background: absolute(value('image')), posterShape: 'landscape', language: 'العربية', website: `${BASE}/news/${key}` },
    // A series landing page's og:video is its trailer, never an episode.
    media: mediaUrl($('video[src]').attr('src') || $('video source[src]').attr('src') || value('video:secure_url') || value('video')),
    embed: $('iframe[src]').map((_, e) => $(e).attr('src')).get().find(u => /^https:\/\/www\.namasha\.com\/embed\/[A-Za-z0-9]+(?:\?|$)/.test(u)),
    category, episodes: parseCards(html, 'series', true),
  };
}
async function request(path) {
  const u = new URL(path, BASE);
  if (!(u.origin === BASE || (u.origin === 'https://www.namasha.com' && /^\/embed\/[A-Za-z0-9]+$/.test(u.pathname)))) throw new Error('Invalid Kawthar upstream');
  const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Kawthar HTTP ${r.status}`);
  return r.text();
}
function createKawtharProvider(get = request) {
  const cache = new Map();
  async function cached(key, work) {
    if (cache.get(key)?.until > Date.now()) return cache.get(key).promise;
    const promise = work();
    if (cache.size > 400) cache.delete(cache.keys().next().value);
    cache.set(key, { until: Date.now() + 600000, promise });
    try { return await promise; } catch (e) { cache.delete(key); throw e; }
  }
  async function list(category, type, episodes = false) {
    return cached(`list:${category}:${episodes}`, async () => {
      const pending = [`/category/${category}${episodes ? '?type=4' : ''}`], seen = new Set(), items = new Map();
      while (pending.length) {
        const path = pending.shift();
        if (seen.has(path)) continue;
        if (seen.size >= 100) throw new Error('Kawthar pagination limit');
        seen.add(path);
        const html = await get(path);
        for (const item of parseCards(html, type, episodes)) items.set(item.id, item);
        for (const next of pageLinks(html, category)) if (!seen.has(next)) pending.push(next);
      }
      return [...items.values()];
    });
  }
  async function catalog(type, extra = {}) {
    if (!categories[type]) return [];
    const all = await list(categories[type], type);
    const search = normalize(extra.search), skip = Math.max(0, Number(extra.skip) || 0);
    return all.filter(x => !search || normalize(x.name).includes(search)).slice(skip, skip + 100);
  }
  async function detail(type, id) {
    const m = /^kawthar:(movie|series):(\d+)$/.exec(id);
    if (!m || m[1] !== type) return null;
    return cached(id, async () => {
      const page = parsePage(await get(`/news/${m[2]}`), type, m[2]);
      if (type === 'series') {
        const episodes = page.category ? await list(page.category, type, true) : page.episodes;
        page.episodes = [...new Map([...page.episodes, ...episodes].map(x => [x.key, x])).values()].sort((a, b) => a.number - b.number);
        page.meta.videos = page.episodes.map(e => ({ id: `${id}:1:${e.key}`, title: e.name, season: 1, episode: e.number, thumbnail: e.poster }));
      }
      return page;
    });
  }
  async function playable(page) {
    if (page.media) return [{ name: 'الكوثر', title: 'تشغيل مباشر', url: page.media }];
    if (!page.embed) return [];
    const u = new URL(page.embed); u.searchParams.set('autoplay', 'true');
    const html = await get(u.href), urls = new Set();
    for (const match of html.matchAll(/['"](?:file|src)['"]\s*:\s*['"]([^'"]+)['"]/g)) {
      const url = mediaUrl(match[1]);
      if (url) urls.add(url);
    }
    return [...urls].map(url => ({ name: 'الكوثر — نماشا', title: /\.mpd/.test(url) ? 'DASH' : 'تشغيل مباشر', url }));
  }
  async function streams(type, id) {
    const m = /^kawthar:(movie|series):(\d+)(?::1:(\d+))?$/.exec(id);
    if (!m || m[1] !== type || (type === 'movie' && m[3])) return [];
    const page = await detail(type, `kawthar:${type}:${m[2]}`);
    if (type === 'movie') return playable(page);
    if (!m[3] || !page.episodes.some(e => e.key === m[3])) return [];
    return playable(parsePage(await cached(`episode:${m[3]}`, () => get(`/episode/${m[3]}`)), type, m[3]));
  }
  return { catalog, detail, streams };
}
module.exports = { createKawtharProvider, parseCards, parsePage, mediaUrl, normalize };
