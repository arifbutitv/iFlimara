'use strict';
const { createProvider } = require('./provider');
const { createShiaProvider } = require('./shiatube');
const manifest = {
  id: 'community.arifbutitv.ifilmar', version: '1.1.1', name: 'آي فيلم العربية',
  description: 'أربع قوائم للأفلام والمسلسلات من آي فيلم وShiaTube، مع البحث والحلقات ومصادر التشغيل.',
  resources: ['catalog', { name: 'meta', types: ['movie', 'series'], idPrefixes: ['ifilmar:', 'shiatube:'] }, { name: 'stream', types: ['movie', 'series'], idPrefixes: ['ifilmar:', 'shiatube:'] }],
  types: ['movie', 'series'], idPrefixes: ['ifilmar:', 'shiatube:'],
  catalogs: ['ifilmar', 'shiatube'].flatMap(source => ['series', 'movie'].map(type => ({ type, id: `${source}-${type}`, name: `${source === 'ifilmar' ? 'آي فيلم' : 'ShiaTube'} — ${type === 'series' ? 'المسلسلات' : 'الأفلام'}`, extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] }))),
  behaviorHints: { adult: false, p2p: false, configurable: false },
};
function createAddon(provider = createProvider(), shia = createShiaProvider(require('./data/shiatube.json'))) {
  return { manifest, async get(resource, type, id, extra = {}) {
    if (resource === 'catalog') return { metas: id === `ifilmar-${type}` ? await provider.catalog(type, extra) : id === `shiatube-${type}` ? await shia.catalog(type, extra) : [], cacheMaxAge: 120 };
    const selected = id.startsWith('shiatube:') ? shia : provider;
    if (resource === 'meta') return { meta: (await selected.detail(type, id))?.meta || null, cacheMaxAge: 120 };
    if (resource === 'stream') return { streams: await selected.streams(type, id), cacheMaxAge: 60 };
    throw new Error('Unknown resource');
  }, shia };
}
module.exports = { createAddon, manifest };
