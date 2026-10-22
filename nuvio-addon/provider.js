'use strict';
const cheerio = require('cheerio');
const BASE = 'https://ar.ifilmtv.ir';
const CDN = 'https://preview.presstv.co.uk/ifilm/';
const routes = { movie: 'Film', series: 'Series' };
const cache = new Map();

function absolute(path) { return path ? new URL(path.trim(), BASE).href : undefined; }
function parseId(value) {
  const m = /^ifilmar:(movie|series):(\d+)(?::1:(\d+))?$/.exec(value);
  return m ? { type: m[1], number: m[2], episode: m[3] ? Number(m[3]) : undefined } : null;
}
function mediaUrl(value) {
  if (!value) return undefined;
  const u = new URL(value.trim(), BASE);
  if (!(u.hostname === 'ifilmtv.ir' || u.hostname.endsWith('.ifilmtv.ir') || u.hostname === 'preview.presstv.co.uk')) return undefined;
  const path = u.pathname.replace(/^\/+/, '').replace(/^ifilm\//, '');
  if (/^UploadedFiles\/Video\//i.test(path)) return CDN + path;
  return u.href;
}
function parseCatalog(html, type) {
  const $ = cheerio.load(html);
  const result = new Map();
  $('.content-all-film a.inner-panel[href]').each((_, el) => {
    const a = $(el);
    const match = /^\/(film|series)\/Content\/(\d+)/i.exec(a.attr('href') || '');
    const title = a.find('h6,h5,h4,h3').first().text().trim();
    if (!match || !title || (match[1].toLowerCase() === 'film' ? 'movie' : 'series') !== type) return;
    const id = `ifilmar:${type}:${match[2]}`;
    result.set(id, { id, type, name: title, poster: absolute(a.find('img').attr('src')), posterShape: 'landscape' });
  });
  return [...result.values()];
}
function parseDetail(html, id) {
  const parsed = parseId(id);
  if (!parsed) throw new Error('Invalid content id');
  const $ = cheerio.load(html);
  const meta = key => $(`meta[property="${key}"]`).attr('content')?.trim();
  const title = meta('og:title') || $('h1').first().text().trim();
  if (!title) throw new Error('Upstream page is missing its title');
  const item = { id, type: parsed.type, name: title, poster: absolute(meta('og:image')), background: absolute(meta('og:image')), posterShape: 'landscape', description: meta('og:description'), language: 'العربية', website: `${BASE}/${routes[parsed.type]}/Content/${parsed.number}` };
  const year = title.match(/\b(19\d{2}|20\d{2})\b/);
  if (year) item.releaseInfo = year[1];
  const external = /var\s+extrafild\s*=\s*"([^"]*)"/.exec(html)?.[1];
  const count = external ? Number(/var\s+inter_\s*=\s*(\d+)/.exec(html)?.[1] || 0) : 0;
  if (count > 5000) throw new Error('Invalid episode count');
  const raw = $('video source[src]').first().attr('src') || $('.Film-movies-panel [data-url]').first().attr('data-url');
  return { meta: item, count, external: Boolean(external), movieUrl: mediaUrl(raw) };
}
async function request(path, json = false) {
  const url = new URL(path, BASE);
  if (url.origin !== BASE) throw new Error('Invalid upstream');
  const key = url.href;
  const previous = cache.get(key);
  if (previous && previous.expires > Date.now()) return previous.promise;
  const promise = (async () => {
    const r = await fetch(url, { signal: AbortSignal.timeout(18000), headers: { 'User-Agent': 'iFlimara-Nuvio/1.0', 'Accept-Language': 'ar' } });
    if (!r.ok) throw new Error(`iFilm returned HTTP ${r.status}`);
    return json ? r.json() : r.text();
  })();
  if (cache.size >= 300) cache.delete(cache.keys().next().value);
  cache.set(key, { promise, expires: Date.now() + 120000 });
  try { return await promise; } catch (e) { cache.delete(key); throw e; }
}
function createProvider(get = request) {
  async function catalog(type, extra = {}) {
    if (!routes[type]) return [];
    const skip = Math.max(0, Math.min(100000, Number(extra.skip) || 0));
    if (extra.search?.trim()) {
      const data = await get(`/Home/Search?${new URLSearchParams({ searchstring: extra.search.trim().slice(0, 200) })}`, true);
      return data.filter(x => x.CategoryId === (type === 'movie' ? 5 : 3) && x.Title && Number.isInteger(x.Id)).map(x => ({ id: `ifilmar:${type}:${x.Id}`, type, name: x.Title, poster: absolute(x.ImageAddress_S), posterShape: 'landscape' })).filter((x, i, all) => all.findIndex(y => y.id === x.id) === i).slice(skip, skip + 100);
    }
    // Stremio clients expect pages of 100; iFilm serves pages of 18.
    const first = Math.floor(skip / 18) + 1;
    const offset = skip % 18;
    const pages = Math.ceil((100 + offset) / 18);
    const batches = await Promise.all(Array.from({ length: pages }, (_, n) => get(`/${routes[type]}?order=1&page=${first + n}`).then(html => parseCatalog(html, type))));
    return batches.flat().slice(offset, offset + 100);
  }
  async function detail(type, id) {
    const parsed = parseId(id);
    if (!parsed || parsed.type !== type || parsed.episode) return null;
    const result = parseDetail(await get(`/${routes[type]}/Content/${parsed.number}`), id);
    result.episodes = [];
    if (type === 'series') {
      if (result.external) {
        result.episodes = Array.from({ length: result.count }, (_, i) => {
          const n = i + 1;
          return { number: n, url: `https://vod.ifilmtv.ir/hls/ar${parsed.number}/,${n},${n}_320,.mp4.urlset/master.m3u8`, mp4: `${CDN}ar${parsed.number}/${n}.mp4`, thumbnail: `${CDN}ar${parsed.number}/${n}.png` };
        });
      } else {
        const seen = new Set();
        for (let page = 1; page <= 200; page++) {
          const batch = await get(`/Home/PageingAttachmentItem?id=${parsed.number}&page=${page}&size=50`, true);
          if (!Array.isArray(batch)) throw new Error('Invalid episode response');
          let added = 0;
          for (const entry of batch) {
            const url = mediaUrl(entry.VideoAddress);
            if (!url || seen.has(url)) continue;
            seen.add(url);
            const number = Number(entry.Episode);
            if (!Number.isInteger(number) || number < 1) continue;
            result.episodes.push({ number, url, thumbnail: absolute(entry.ImageAddress_M) });
            added++;
          }
          if (!added) break;
        }
      }
      result.episodes.sort((a, b) => a.number - b.number);
      result.meta.videos = result.episodes.map(ep => ({ id: `${id}:1:${ep.number}`, title: `الحلقة ${ep.number}`, season: 1, episode: ep.number, thumbnail: ep.thumbnail, available: true }));
    }
    return result;
  }
  async function streams(type, id) {
    const parsed = parseId(id);
    if (!parsed || parsed.type !== type || (type === 'series' && !parsed.episode)) return [];
    const base = `ifilmar:${type}:${parsed.number}`;
    const result = await detail(type, base);
    if (!result) return [];
    const ep = type === 'series' ? result.episodes.find(x => x.number === parsed.episode) : null;
    const urls = type === 'movie' ? [result.movieUrl] : [ep?.url, ep?.mp4];
    return urls.filter(Boolean).map(url => ({ name: 'آي فيلم العربية', title: url.includes('.m3u8') ? 'HLS — جودة تلقائية' : 'MP4', url, behaviorHints: { notWebReady: url.includes('.m3u8'), bingeGroup: `ifilmar-${url.includes('.m3u8') ? 'hls' : 'mp4'}`, filename: new URL(url).pathname.split('/').pop() } }));
  }
  return { catalog, detail, streams };
}
module.exports = { createProvider, parseCatalog, parseDetail, parseId, mediaUrl };
