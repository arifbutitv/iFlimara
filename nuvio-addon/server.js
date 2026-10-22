'use strict';
const express = require('express');
const { createAddon } = require('./addon');
const app = express();
const addon = createAddon();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if (req.url.length > 3000) return res.status(414).json({ error: 'Request too long' });
  next();
});
app.get('/', (_req, res) => res.type('html').send('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>آي فيلم — Nuvio</title><body style="font:20px system-ui;max-width:700px;margin:60px auto;padding:24px"><h1>آي فيلم العربية</h1><p>إضافة Nuvio للأفلام والمسلسلات والبحث.</p><p>انسخ رابط <a href="manifest.json">manifest.json</a> من هذا الخادم والصقه في Nuvio ← الإعدادات ← الإضافات ← إضافة Addon.</p><p>المحتوى المتاح يعتمد على الموقع الرسمي؛ بعض الأفلام تحتوي إعلاناً فقط.</p></body></html>'));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/manifest.json', (_req, res) => res.json(addon.manifest));
app.get(/^\/(catalog|meta|stream)\/(movie|series)\/([^/]+?)(?:\/([^/]+))?\.json$/, async (req, res) => {
  const resource = req.params[0], type = req.params[1], id = req.params[2];
  try {
    // Read raw extras to preserve escaped '&' and '/' inside search queries.
    const raw = req.originalUrl.split('?')[0].split('/');
    const extra = Object.fromEntries(new URLSearchParams(raw.length === 5 ? raw[4].slice(0, -5) : ''));
    const result = await addon.get(resource, type, id, extra);
    res.set('Cache-Control', `public, max-age=${result.cacheMaxAge || 60}`);
    res.json(result);
  } catch (error) {
    console.error('iFilm request failed:', error.message);
    res.status(502).json({ error: 'تعذر الاتصال بموقع آي فيلم، حاول مرة أخرى' });
  }
});
if (require.main === module) app.listen(process.env.PORT || 7000, '0.0.0.0', () => console.log(`iFilm addon listening on ${process.env.PORT || 7000}`));
module.exports = app;
