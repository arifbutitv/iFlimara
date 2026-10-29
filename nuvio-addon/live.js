'use strict';
const cheerio = require('cheerio');
const crypto = require('node:crypto');
const channels = [
  { key: 'ifilm', name: 'iFilm', arabic: 'آي فيلم العربية', website: 'https://ar.ifilmtv.ir/Home/Live', poster: 'https://ar.ifilmtv.ir/img/final-logo01.png' },
  { key: 'kawthar', name: 'Al-Kawthar', arabic: 'الكوثر', website: 'https://www.alkawthartv.ir/live', poster: 'https://lb-cdn.sepehrtv.ir/img/channel/logo/alkowsar.png' },
  { key: 'almaaref', name: 'Al-Maaref', arabic: 'المعارف', website: 'https://almaaref.ch/البث-المباشر-6/', poster: 'https://almaaref.ch/wp-content/uploads/elementor/thumbs/Almaaref-Logo-white-qfl1sieramw1phb614lea7dmzi7lg9sd1zkc08ecqo.png' },
];
const FRAME = 'https://sepehrtv.ir/frame/t/alkosar?logo=0';
const API = 'https://sepehrapi.sepehrtv.ir/beta/v0/channels/get?key=alkosar&include_media_resources=true&include_details=true';
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
function oauthHeader(url, client, nonce = crypto.randomBytes(16).toString('hex'), time = Math.floor(Date.now() / 1000)) {
  const u = new URL(url), p = { oauth_consumer_key: client.key, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: String(time), oauth_version: '1.0' };
  const pairs = [...u.searchParams, ...Object.entries(p)].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  const base = ['GET', u.origin + u.pathname, pairs.map(x => x.join('=')).join('&')].map(enc).join('&');
  p.oauth_signature = crypto.createHmac('sha1', enc(client.secret) + '&').update(base).digest('base64');
  return 'OAuth ' + Object.entries(p).map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(', ');
}
function allowedStream(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && /\.m3u8$/i.test(u.pathname) && (u.hostname === 'live.presstv.co.uk' || u.hostname === 'sepehrtv.ir' || u.hostname.endsWith('.sepehrtv.ir') || u.hostname.endsWith('.zeuscdn724.com'));
  } catch { return false; }
}
function hlsSources(html) {
  const $ = cheerio.load(html), found = new Set();
  $('source[src],video[src],[srcjsplayer]').each((_, e) => { const v = $(e).attr('src') || $(e).attr('srcjsplayer'); if (allowedStream(v)) found.add(v); });
  // WordPress players store HTML-encoded JSON in attributes. Decode entities
  // with Cheerio and unescape JSON slashes; never execute upstream scripts.
  $('*').each((_, e) => {
    for (const raw of Object.values(e.attribs || {})) {
      for (const m of raw.replace(/\\\//g, '/').matchAll(/https:\/\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/g)) if (allowedStream(m[0])) found.add(m[0]);
    }
  });
  return [...found];
}
async function request(url, headers = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || (!allowedStream(url) && !['ar.ifilmtv.ir', 'www.alkawthartv.ir', 'almaaref.ch', 'sepehrtv.ir', 'sepehrapi.sepehrtv.ir'].includes(u.hostname))) throw new Error('Invalid live upstream');
  const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) { const e = new Error(`Live upstream HTTP ${r.status}`); e.status = r.status; throw e; }
  return r.text();
}
function createLiveProvider(get = request) {
  let publicClient, clientUntil = 0, clientLoading;
  const cache = new Map();
  async function loadClient() {
    if (publicClient && clientUntil > Date.now()) return publicClient;
    if (clientLoading) return clientLoading;
    clientLoading = (async () => {
      // These are the public, anonymous web-player client parameters. No user
      // account, login token or private credential is read or persisted.
      const $ = cheerio.load(await get(FRAME, { Referer: channels[1].website }));
      const scripts = $('script[src]').map((_, e) => {
        const u = new URL($(e).attr('src'), FRAME);
        return ['sepehrtv.ir', 'lb-cdn.sepehrtv.ir'].includes(u.hostname) && u.pathname.startsWith('/_next/static/chunks/') ? 'https://sepehrtv.ir' + u.pathname : null;
      }).get().filter(Boolean).slice(0, 40).sort((a, b) => Number(/\/7164-/.test(b)) - Number(/\/7164-/.test(a)));
      for (let start = 0; start < scripts.length; start += 4) {
        const results = await Promise.allSettled(scripts.slice(start, start + 4).map(u => get(u)));
        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          const m = /consumer:\s*\{\s*key:\s*"([^"]+)",\s*secret:\s*"([^"]+)"\s*\}/.exec(result.value);
          if (m) { publicClient = { key: m[1], secret: m[2] }; clientUntil = Date.now() + 3600000; return publicClient; }
        }
      }
      throw new Error('Official live player configuration unavailable');
    })();
    try { return await clientLoading; } finally { clientLoading = undefined; }
  }
  function channel(type, id) { return type === 'tv' ? channels.find(c => id === `ifilmar-live:${c.key}`) : undefined; }
  function meta(c) { return { id: `ifilmar-live:${c.key}`, type: 'tv', name: c.name, description: `${c.arabic} — البث المباشر`, poster: c.poster, logo: c.poster, posterShape: 'square', genres: ['TV Live'], language: 'العربية', website: c.website }; }
  async function resolve(c) {
    if (c.key !== 'kawthar') {
      const sources = hlsSources(await get(c.website));
      if (c.key !== 'ifilm') return sources;
      const valid = [];
      for (const source of sources) {
        const master = await get(source);
        if (!master.startsWith('#EXTM3U')) continue;
        if (!master.includes('#EXT-X-STREAM-INF:')) { valid.push(source); continue; }
        const variants = master.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#')).map(line => new URL(line.trim(), source).href).filter(allowedStream).slice(0, 12);
        const responses = await Promise.allSettled(variants.map(url => get(url)));
        responses.forEach((r, i) => { if (r.status === 'fulfilled' && r.value.startsWith('#EXTM3U') && r.value.includes('#EXTINF:')) valid.push(variants[i]); });
      }
      return valid;
    }
    // Confirm the official page still embeds this public player.
    const $ = cheerio.load(await get(c.website));
    if (!$('iframe[src]').toArray().some(e => $(e).attr('src')?.startsWith(FRAME.split('?')[0]))) throw new Error('Kawthar live player changed');
    for (let attempt = 0; attempt < 2; attempt++) {
      const client = await loadClient();
      try {
        const data = JSON.parse(await get(API, { Authorization: oauthHeader(API, client) }));
        return (data.list || []).filter(x => x.uid === 'alkosar').flatMap(x => x.streams || []).map(x => x.src).filter(allowedStream);
      } catch (e) { if (e.status !== 401 || attempt) throw e; clientUntil = 0; }
    }
  }
  return {
    async catalog(type, extra = {}) {
      if (type !== 'tv') return [];
      const search = String(extra.search || '').trim().toLowerCase();
      const skip = Math.max(0, Number(extra.skip) || 0);
      return channels.filter(c => `${c.name} ${c.arabic}`.toLowerCase().includes(search)).slice(skip, skip + 100).map(meta);
    },
    async detail(type, id) { const c = channel(type, id); return c ? { meta: meta(c) } : null; },
    async streams(type, id) {
      const c = channel(type, id); if (!c) return [];
      if (cache.get(id)?.until > Date.now()) return cache.get(id).promise;
      const promise = resolve(c).then(urls => urls.map((url, i) => ({ name: c.name, title: `البث المباشر • HLS${urls.length > 1 ? ` • ${i + 1}` : ''}`, url, behaviorHints: { notWebReady: true } })));
      cache.set(id, { until: Date.now() + 30000, promise });
      try { return await promise; } catch (e) { cache.delete(id); throw e; }
    },
  };
}
module.exports = { createLiveProvider, hlsSources, allowedStream, oauthHeader };
