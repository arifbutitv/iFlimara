'use strict';
const { validateIndex, queryPage } = require('./recent-index');
const DEFAULT_URL = 'https://raw.githubusercontent.com/arifbutitv/iFlimara/content-index/recent.json';

function createRecentProvider({ url = process.env.RECENT_INDEX_URL || DEFAULT_URL, get = fetch } = {}) {
  let index, refreshJob, timer, etag;
  async function refresh() {
    if (refreshJob) return refreshJob;
    refreshJob = (async () => {
      const response = await get(url + (url.includes('?') ? '&' : '?') + `v=${Math.floor(Date.now() / 60000)}`, {
        signal: AbortSignal.timeout(15000),
        headers: etag ? { 'If-None-Match': etag } : {},
      });
      if (response.status === 304 && index) return;
      if (!response.ok) throw new Error(`Recent index HTTP ${response.status}`);
      const body = await response.text();
      if (Buffer.byteLength(body) > 25000000) throw new Error('Recent index download too large');
      const next = validateIndex(JSON.parse(body));
      if (index && next.revision < index.revision) throw new Error('Refused older recent revision');
      index = next;
      etag = response.headers.get('etag');
    })();
    try { await refreshJob; } finally { refreshJob = undefined; }
  }
  function start() {
    if (timer) return;
    const poll = () => refresh().catch(error => console.error('Recent index refresh:', error.message));
    timer = setInterval(poll, 60000);
    timer.unref();
    return poll();
  }
  return {
    start, refresh,
    stop() { clearInterval(timer); timer = undefined; },
    status() { return { ready: Boolean(index), revision: index?.revision, updatedAt: index?.updatedAt, sources: index?.sources }; },
    async catalog(type, extra = {}) {
      if (type !== 'other') return { metas: [] };
      if (!index) { const error = new Error('Recent index is not ready'); error.code = 'RECENT_NOT_READY'; throw error; }
      return queryPage(index, extra);
    },
  };
}
module.exports = { createRecentProvider };
