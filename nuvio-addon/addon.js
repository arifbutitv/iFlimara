'use strict';
const { createProvider } = require('./provider');
const manifest = {
  id: 'community.arifbutitv.ifilmar', version: '1.0.0', name: 'آي فيلم العربية | iFlimara',
  description: 'أفلام ومسلسلات آي فيلم العربية: تصفح، بحث، وحلقات من الموقع الرسمي. بعض الأفلام توفر مقطعاً تعريفياً فقط.',
  resources: ['catalog', { name: 'meta', types: ['movie', 'series'], idPrefixes: ['ifilmar:'] }, { name: 'stream', types: ['movie', 'series'], idPrefixes: ['ifilmar:'] }],
  types: ['movie', 'series'], idPrefixes: ['ifilmar:'],
  catalogs: ['series', 'movie'].map(type => ({ type, id: `ifilmar-${type}`, name: type === 'series' ? 'آي فيلم — المسلسلات' : 'آي فيلم — الأفلام', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] })),
  behaviorHints: { adult: false, p2p: false, configurable: false },
};
function createAddon(provider = createProvider()) {
  return { manifest, async get(resource, type, id, extra = {}) {
    if (resource === 'catalog') return { metas: id === `ifilmar-${type}` ? await provider.catalog(type, extra) : [], cacheMaxAge: 120 };
    if (resource === 'meta') return { meta: (await provider.detail(type, id))?.meta || null, cacheMaxAge: 120 };
    if (resource === 'stream') return { streams: await provider.streams(type, id), cacheMaxAge: 60 };
    throw new Error('Unknown resource');
  } };
}
module.exports = { createAddon, manifest };
