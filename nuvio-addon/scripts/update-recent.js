'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { createAddon } = require('../addon');
const { createShiaProvider } = require('../shiatube');
const { createDailymotionProvider } = require('../dailymotion');
const { createRecentSources } = require('../recent-sources');
const { readIndex, writeIndex, withIndexLock, updateIndex } = require('../recent-index');

async function main() {
  const file = process.env.RECENT_INDEX_FILE;
  if (!file || !path.isAbsolute(file)) throw new Error('Set RECENT_INDEX_FILE to an absolute path in the durable state checkout');
  if (!fs.existsSync(file) && process.env.RECENT_BOOTSTRAP !== '1') throw new Error('Durable recent ledger missing. Refusing to reset firstSeenAt. Restore the published ledger or explicitly set RECENT_BOOTSTRAP=1 for a first initialization');
  await withIndexLock(file, async () => {
    const snapshot = require('../data/shiatube.json');
    const shia = createShiaProvider(snapshot, { refresh: false });
    const dailymotion = createDailymotionProvider();
    const addon = createAddon(undefined, shia, undefined, undefined, undefined, undefined, undefined, undefined, dailymotion);
    const sources = createRecentSources(addon, snapshot, dailymotion);
    const index = readIndex(file);
    const results = await updateIndex(index, sources, { pageBudget: Number(process.env.RECENT_PAGE_BUDGET) || 3 });
    writeIndex(file, index);
    for (let i = 0; i < sources.length; i++) console.log(sources[i].key, JSON.stringify(results[i]));
    console.log(JSON.stringify({ revision: index.revision, records: Object.keys(index.records).length, updatedAt: index.updatedAt }));
    if (results.every(result => result.error)) throw new Error('All recent sources failed. Existing records were preserved');
  });
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
