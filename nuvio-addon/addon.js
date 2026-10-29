'use strict';
const { createProvider } = require('./provider');
const { createShiaProvider } = require('./shiatube');
const { createKawtharProvider } = require('./kawthar');
const { createLiveProvider } = require('./live');
const { createScheduleProvider } = require('./schedule');
const { createProgramsProvider } = require('./programs');
const manifest = {
  id: 'community.arifbutitv.ifilmar', version: '1.7.0', name: 'ArifButi VIP',
  description: 'TV Live وقوائم الأفلام والمسلسلات من آي فيلم وShiaTube والكوثر، مع البحث والحلقات ومصادر التشغيل.',
  resources: ['catalog', { name: 'meta', types: ['movie', 'series'], idPrefixes: ['ifilmar:', 'shiatube:', 'kawthar:'] }, { name: 'stream', types: ['movie', 'series'], idPrefixes: ['ifilmar:', 'shiatube:', 'kawthar:'] }],
  types: ['movie', 'series'], idPrefixes: ['ifilmar:', 'shiatube:', 'kawthar:'],
  catalogs: ['ifilmar', 'shiatube', 'kawthar'].flatMap(source => ['series', 'movie'].map(type => ({ type, id: `${source}-${type}`, name: `${({ ifilmar: 'آي فيلم', shiatube: 'ShiaTube', kawthar: 'الكوثر' })[source]} — ${type === 'series' ? 'المسلسلات' : 'الأفلام'}`, extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] }))),
  behaviorHints: { adult: false, p2p: false, configurable: false },
};
// Keep the live catalog first in the manifest so clients show it first.
manifest.types.unshift('tv');
manifest.idPrefixes.push('ifilmar-live:');
manifest.idPrefixes.push('ifilmar-schedule:');
for (const resource of manifest.resources) if (typeof resource === 'object') {
  resource.types.push('tv'); resource.idPrefixes.push('ifilmar-live:');
  resource.idPrefixes.push('ifilmar-schedule:');
}
manifest.catalogs.unshift({ type: 'tv', id: 'ifilmar-live', name: 'TV Live', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] });
manifest.catalogs.splice(1, 0, { type: 'tv', id: 'ifilmar-schedule', name: 'جدول البث iFilm', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] });
for (const [source, name] of [['ifilmar', 'آي فيلم'], ['kawthar', 'الكوثر']]) {
  manifest.catalogs.splice(manifest.catalogs.findIndex(c => c.id === `${source}-movie`) + 1, 0, { type: 'series', id: `${source}-programs`, name: `${name} — البرامج`, extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] });
  manifest.idPrefixes.push(`${source}-program:`);
  for (const resource of manifest.resources) if (typeof resource === 'object') resource.idPrefixes.push(`${source}-program:`);
}
const catalogOrder = ['ifilmar-live', 'ifilmar-schedule', 'ifilmar-series', 'ifilmar-movie', 'ifilmar-programs', 'kawthar-series', 'kawthar-movie', 'kawthar-programs', 'shiatube-series', 'shiatube-movie'];
manifest.catalogs.sort((a, b) => catalogOrder.indexOf(a.id) - catalogOrder.indexOf(b.id));
function createAddon(provider = createProvider(), shia = createShiaProvider(require('./data/shiatube.json')), kawthar = createKawtharProvider(), live = createLiveProvider(), schedule = createScheduleProvider(live), ifilmPrograms = createProgramsProvider('ifilm'), kawtharPrograms = createProgramsProvider('kawthar')) {
  return { manifest, async get(resource, type, id, extra = {}) {
    const programs = resource === 'catalog' ? (id === 'ifilmar-programs' ? ifilmPrograms : id === 'kawthar-programs' ? kawtharPrograms : null) : (id.startsWith('ifilmar-program:') ? ifilmPrograms : id.startsWith('kawthar-program:') ? kawtharPrograms : null);
    if (programs) {
      if (resource === 'catalog') return { metas: await programs.catalog(type, extra), cacheMaxAge: 120 };
      if (resource === 'meta') return { meta: (await programs.detail(type, id))?.meta || null, cacheMaxAge: 120 };
      if (resource === 'stream') return { streams: await programs.streams(type, id), cacheMaxAge: 60 };
    }
    if (type === 'tv') {
      if (resource === 'catalog' && id === 'ifilmar-schedule') return { metas: await schedule.catalog(type, extra), cacheMaxAge: 60 };
      if (id.startsWith('ifilmar-schedule:')) {
        if (resource === 'meta') return { meta: (await schedule.detail(type, id))?.meta || null, cacheMaxAge: 60 };
        if (resource === 'stream') return { streams: await schedule.streams(type, id), cacheMaxAge: 15 };
      }
      if (resource === 'catalog') return { metas: id === 'ifilmar-live' ? await live.catalog(type, extra) : [], cacheMaxAge: 120 };
      if (resource === 'meta') return { meta: (await live.detail(type, id))?.meta || null, cacheMaxAge: 120 };
      if (resource === 'stream') return { streams: await live.streams(type, id), cacheMaxAge: 15 };
    }
    if (resource === 'catalog') return { metas: id === `ifilmar-${type}` ? await provider.catalog(type, extra) : id === `shiatube-${type}` ? await shia.catalog(type, extra) : id === `kawthar-${type}` ? await kawthar.catalog(type, extra) : [], cacheMaxAge: 120 };
    const selected = id.startsWith('kawthar:') ? kawthar : id.startsWith('shiatube:') ? shia : provider;
    if (resource === 'meta') return { meta: (await selected.detail(type, id))?.meta || null, cacheMaxAge: 120 };
    if (resource === 'stream') return { streams: await selected.streams(type, id), cacheMaxAge: 60 };
    throw new Error('Unknown resource');
  }, shia };
}
module.exports = { createAddon, manifest };
