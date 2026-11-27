'use strict';
const { groupSeries } = require('./shiatube');

function createRecentSources(addon, snapshot, dailymotion) {
  const groups = new Map(groupSeries(snapshot.series).map(group => [group.key, group]));
  return addon.manifest.catalogs.filter(catalog => ['movie', 'series'].includes(catalog.type)).map(catalog => ({
    key: catalog.id,
    async page(skip) {
      if (catalog.id === 'dailymotion-playlists') return dailymotion.recentCatalog({ skip });
      const result = await addon.get('catalog', catalog.type, catalog.id, { skip });
      return result.metas.map(meta => {
        if (catalog.id !== 'shiatube-series') return { meta };
        const group = groups.get(meta.id.split(':').at(-1));
        if (!group) throw new Error('ShiaTube original episode identities unavailable');
        return { meta, aliases: group.episodes.map(video => `shiatube-series-video:${video.id}`) };
      });
    },
  }));
}
module.exports = { createRecentSources };
