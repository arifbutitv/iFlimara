'use strict';
const cheerio = require('cheerio');
const { createProvider } = require('./provider');
const { createKawtharProvider, parsePage, normalize } = require('./kawthar');
const hosts = { ifilm: 'https://ar.ifilmtv.ir', kawthar: 'https://www.alkawthartv.ir' };
function createProgramsProvider(source, read) {
  const base = hosts[source];
  if (!base) throw new Error('Unknown program source');
  const prefix = source === 'ifilm' ? 'ifilmar-program:' : 'kawthar-program:';
  const cache = new Map();
  async function cached(key, work) {
    if (cache.get(key)?.until > Date.now()) return cache.get(key).promise;
    const promise = work();
    if (cache.size > 400) cache.delete(cache.keys().next().value);
    cache.set(key, { promise, until: Date.now() + 600000 });
    try { return await promise; } catch (e) { cache.delete(key); throw e; }
  }
  async function get(path, json = false) {
    return cached(`get:${path}:${json}`, async () => {
      if (read) return read(path, json);
      const url = new URL(path, base);
      if (!(url.origin === base || (source === 'kawthar' && url.origin === 'https://www.namasha.com' && /^\/embed\/[A-Za-z0-9]+$/.test(url.pathname)))) throw new Error('Invalid program upstream');
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`Programs HTTP ${r.status}`);
      return json ? r.json() : r.text();
    });
  }
  const ifilm = source === 'ifilm' ? createProvider((path, json) => get(path.replace('/Series/Content/', '/Program/Content/'), json)) : null;
  const kawthar = source === 'kawthar' ? createKawtharProvider(get) : null;
  function cards(html, episodes = false) {
    const $ = cheerio.load(html), found = new Map();
    const area = episodes && $('.favourite-slider').length ? $('.favourite-slider').first() : $.root();
    area.find('a[href]').each((_, e) => {
      const a = $(e); let url;
      try { url = new URL(a.attr('href'), base); } catch { return; }
      const m = (episodes ? /^\/(?:episode|news)\/(\d+)$/ : /^\/epi\/(\d+)$/).exec(url.pathname);
      const title = a.find('h6.iq-title,h2.news-title').first().text().trim();
      if (url.origin !== base || !m || !title) return;
      const img = a.find('img').first(), image = img.attr('data-src') || img.attr('src');
      found.set(m[1], { id: prefix + m[1], key: m[1], type: 'series', name: title, poster: image ? new URL(image, base).href : undefined, posterShape: 'landscape' });
    });
    return [...found.values()];
  }
  async function allPrograms() {
    return cached('programs', async () => {
      if (source === 'kawthar') return cards(await get('/programs'));
      const found = new Map();
      for (let page = 1; page <= 100; page++) {
        const rows = await get(`/Home/PageingItem?category=7&page=${page}&size=150&orderby=1`, true);
        if (!Array.isArray(rows)) throw new Error('Invalid iFilm program list');
        let added = 0;
        for (const row of rows) {
          if (!Number.isInteger(row.Id) || !row.Title || found.has(row.Id)) continue;
          found.set(row.Id, { id: prefix + row.Id, type: 'series', name: row.Title, poster: row.ImageAddress_M ? new URL(row.ImageAddress_M, base).href : undefined, posterShape: 'landscape' }); added++;
        }
        if (!added || rows.length < 150) break;
      }
      return [...found.values()];
    });
  }
  function parse(type, id) { return type === 'series' && id.startsWith(prefix) ? /^(\d+)(?::1:(\d+))?$/.exec(id.slice(prefix.length)) : null; }
  async function detail(type, id) {
    const m = parse(type, id); if (!m || m[2]) return null;
    return cached(`detail:${id}`, async () => {
      if (source === 'ifilm') {
        const page = await ifilm.detail('series', `ifilmar:series:${m[1]}`);
        const meta = { ...page.meta, id, website: `${base}/Program/Content/${m[1]}`, videos: page.meta.videos.map(v => ({ ...v, id: v.id.replace(`ifilmar:series:${m[1]}`, id) })) };
        return { meta };
      }
      const html = await get(`/epi/${m[1]}`), page = parsePage(html, 'series', m[1]);
      let episodes = cards(html, true);
      if (!episodes.length && page.category) episodes = cards(await get(`/category/${page.category}?type=4`), true);
      // Program episodes often have dates or topic titles rather than episode
      // numbers. Keep every episode in the official page's episode section;
      // exclude the separate clips section and preserve stable source IDs.
      episodes.sort((a, b) => Number(a.key) - Number(b.key));
      return { meta: { ...page.meta, id, website: `${base}/epi/${m[1]}`, videos: episodes.map((e, i) => ({ id: `${id}:1:${e.key}`, season: 1, episode: i + 1, title: e.name, thumbnail: e.poster })) }, episodes };
    });
  }
  return {
    async catalog(type, extra = {}) {
      if (type !== 'series') return [];
      const all = await allPrograms(), search = normalize(extra.search), skip = Math.max(0, Number(extra.skip) || 0);
      return all.filter(x => !search || normalize(x.name).includes(search)).slice(skip, skip + 100);
    },
    detail,
    async streams(type, id) {
      const m = parse(type, id); if (!m || !m[2]) return [];
      if (source === 'ifilm') return ifilm.streams('series', `ifilmar:series:${m[1]}:1:${m[2]}`);
      const page = await detail(type, prefix + m[1]);
      if (!page.episodes.some(x => x.key === m[2])) return [];
      return kawthar.playable(parsePage(await get(`/episode/${m[2]}`), 'series', m[2]));
    },
  };
}
module.exports = { createProgramsProvider };
