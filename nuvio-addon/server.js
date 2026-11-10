'use strict';
const express = require('express');
const { createAddon } = require('./addon');
const app = express();
const addon = createAddon();
app.disable('x-powered-by');
app.use('/assets', express.static(require('node:path').join(__dirname, 'assets'), { maxAge: '1d', setHeaders: res => res.setHeader('Access-Control-Allow-Origin', '*') }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Range');
  res.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if (req.url.length > 3000) return res.status(414).json({ error: 'Request too long' });
  next();
});
app.get('/', (_req, res) => res.type('html').send('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ArifButi VIP — Nuvio</title><body style="font:20px system-ui;max-width:700px;margin:60px auto;padding:24px"><h1>ArifButi VIP</h1><p>إضافة Nuvio للأفلام والمسلسلات والبحث.</p><p>انسخ رابط <a href="manifest.json">manifest.json</a> من هذا الخادم والصقه في Nuvio ← الإعدادات ← الإضافات ← إضافة Addon.</p><p>المحتوى المتاح يعتمد على الموقع الرسمي؛ بعض الأفلام تحتوي إعلاناً فقط.</p></body></html>'));
app.get('/health', (_req, res) => res.json({ status: 'ok', content: addon.shia.contentState() }));
// Send previously cached playback links to the original watch page.
app.get(/^\/shiatube\/play\/([A-Za-z0-9]{10,40})\.mp4$/, (req, res) => {
  const url = addon.shia.findWatchUrl(req.params[0]);
  if (!url) return res.sendStatus(404);
  return res.set("Cache-Control", "no-store").redirect(302, url);
});
app.get('/manifest.json', (req, res) => {
  const scheme = req.get('x-forwarded-proto')?.split(',')[0] === 'https' || req.secure ? 'https' : 'http';
  res.json({ ...addon.manifest, logo: new URL(addon.manifest.logo, `${scheme}://${req.get('host')}`).href });
});
// Android browsers need a user click to launch a package-specific intent.
app.get(/^\/open\/tizentube\/([A-Za-z0-9_-]{11})\/([A-Za-z0-9_-]{10,80})$/, (req, res) => {
  const [video, playlist] = [req.params[0], req.params[1]];
  const watch = `www.youtube.com/watch?v=${video}&amp;list=${playlist}`;
  const intent = `intent://${watch}#Intent;scheme=https;package=io.gh.reisxd.tizentube.cobalt;end`;
  res.type('html').send(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>فتح في TizenTubeCobalt</title><style>body{font:24px system-ui;background:#151320;color:#fff;padding:2rem}a{display:block;width:fit-content;margin:1rem 0;padding:.75rem 1rem;border-radius:.5rem;background:#eee;color:#151320}a:focus{outline:4px solid #be94ff}</style><h1>مشاهدة الفيديو</h1><a href="${intent}" autofocus>فتح في TizenTubeCobalt</a><a href="https://${watch}">فتح في YouTube</a></html>`);
});
app.get(/^\/(catalog|meta|stream)\/(movie|series|tv)\/([^/]+?)(?:\/([^/]+))?\.json$/, async (req, res) => {
  const resource = req.params[0], type = req.params[1], id = req.params[2];
  try {
    // Read raw extras to preserve escaped '&' and '/' inside search queries.
    const raw = req.originalUrl.split('?')[0].split('/');
    const extra = Object.fromEntries(new URLSearchParams(raw.length === 5 ? raw[4].slice(0, -5) : ''));
    const result = await addon.get(resource, type, id, extra);
    // Relative stream addresses become the actual deployment's HTTPS origin.
    const host = req.get('host');
    const scheme = req.get('x-forwarded-proto')?.split(',')[0] === 'https' || req.secure ? 'https' : 'http';
    const absoluteArtwork = item => {
      for (const key of ['poster', 'logo', 'background']) if (item[key]?.startsWith('/assets/')) item[key] = `${scheme}://${host}${item[key]}`;
      return item;
    };
    if (result.metas) result.metas = result.metas.map(absoluteArtwork);
    if (result.meta) result.meta = absoluteArtwork(result.meta);
    if (result.streams) result.streams = result.streams.map(stream => {
      const output = { ...stream };
      for (const key of ['url', 'externalUrl']) {
        if (output[key]?.startsWith('/')) output[key] = `${scheme}://${host}${output[key]}`;
      }
      return output;
    });
    res.set('Cache-Control', `public, max-age=${result.cacheMaxAge || 60}`);
    res.json(result);
  } catch (error) {
    console.error('iFilm request failed:', error.message);
    res.status(502).json({ error: 'تعذر الاتصال بموقع آي فيلم، حاول مرة أخرى' });
  }
});
if (require.main === module) app.listen(process.env.PORT || 7000, '0.0.0.0', () => console.log(`iFilm addon listening on ${process.env.PORT || 7000}`));
module.exports = app;
