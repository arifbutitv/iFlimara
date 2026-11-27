'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { normalize } = require('./kawthar');

function emptyIndex() {
  return { version: 1, revision: 0, updatedAt: null, sources: {}, records: {}, views: {} };
}

function validateIndex(index) {
  if (index?.version !== 1 || !Number.isSafeInteger(index.revision) || index.revision < 0 || typeof index.records !== 'object' || !index.records || typeof index.sources !== 'object' || !index.sources || Array.isArray(index.records) || Array.isArray(index.sources)) throw new Error('Invalid recent index');
  if (Object.keys(index.records).length > 50000) throw new Error('Recent index exceeds record limit');
  for (const [key, record] of Object.entries(index.records)) {
    if (record.key !== key || !Array.isArray(record.aliases) || !record.aliases.length || !['movie', 'series'].includes(record.meta?.type) || typeof record.meta.id !== 'string' || !record.meta.name || !Number.isFinite(Date.parse(record.firstSeenAt)) || !Array.isArray(record.sources)) throw new Error('Invalid recent record');
    if (record.sourceAddedAt !== null && !Number.isFinite(Date.parse(record.sourceAddedAt))) throw new Error('Invalid source addition date');
  }
  for (const state of Object.values(index.sources)) {
    if (typeof state.initialized !== 'boolean' || !Number.isInteger(state.cursor) || state.cursor < 100 || state.cursor % 100) throw new Error('Invalid recent source cursor');
  }
  for (const [revision, view] of Object.entries(index.views || {})) {
    if (!/^\d+$/.test(revision) || Number(revision) > index.revision || !Array.isArray(view)) throw new Error('Invalid recent view');
    const seen = new Set();
    for (const item of view) {
      if (!index.records[item.key] || typeof item.name !== 'string' || seen.has(item.key)) throw new Error('Invalid recent view entry');
      seen.add(item.key);
    }
  }
  return index;
}

function readIndex(file) {
  if (!fs.existsSync(file)) return emptyIndex();
  return validateIndex(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function writeIndex(file, index) {
  validateIndex(index);
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'wx');
  try {
    fs.writeFileSync(fd, JSON.stringify(index) + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}

async function withIndexLock(file, work) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const fd = fs.openSync(lock, 'wx');
  try { return await work(); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

function originalIdentity(meta) {
  const patterns = [
    [/^ifilmar:(?:movie|series):(\d+)$/, 'ifilm'],
    [/^ifilmar-program:(\d+)$/, 'ifilm'],
    [/^kawthar:(?:movie|series):(\d+)$/, 'kawthar'],
    [/^kawthar-program:(\d+)$/, 'kawthar'],
    [/^shiatube:movie:([A-Za-z0-9]+)$/, 'shiatube-movie'],
    [/^noradrama:([A-Za-z0-9_-]+)$/, 'youtube-playlist'],
    [/^dailymotion:([A-Za-z0-9]+)$/, 'dailymotion-playlist'],
  ];
  for (const [pattern, source] of patterns) {
    const match = pattern.exec(meta.id);
    if (match) return `${source}:${match[1]}`;
  }
  throw new Error(`Missing original identity for ${meta.id}`);
}

function observe(index, source, observations, observedAt) {
  const aliases = new Map();
  for (const record of Object.values(index.records)) for (const alias of record.aliases) aliases.set(alias, record.key);
  for (const observation of observations) {
    const { meta, baseline } = observation;
    if (!meta?.id || !meta.name || !['movie', 'series'].includes(meta.type)) throw new Error('Invalid source metadata');
    const identities = observation.aliases || [originalIdentity(meta)];
    if (!identities.length) throw new Error('Empty original identity');
    const matches = new Set(identities.map(alias => aliases.get(alias)).filter(Boolean));
    if (matches.size > 1) throw new Error('Ambiguous original content identity');
    const key = matches.size ? [...matches][0] : identities[0];
    let record = index.records[key];
    const sourceTime = observation.sourceAddedAt;
    const validTime = typeof sourceTime === 'string' && Number.isFinite(Date.parse(sourceTime)) && Date.parse(sourceTime) <= Date.parse(observedAt);
    if (!record) {
      record = { key, aliases: [], meta, primarySource: source, sources: [], firstSeenAt: observedAt, sourceAddedAt: null, baseline: Boolean(baseline) };
      index.records[key] = record;
    }
    if (record.primarySource === source) record.meta = meta;
    if (!record.sources.includes(source)) record.sources.push(source);
    if (validTime && !record.sourceAddedAt) record.sourceAddedAt = new Date(sourceTime).toISOString();
    for (const alias of identities) {
      if (!record.aliases.includes(alias)) record.aliases.push(alias);
      aliases.set(alias, key);
    }
  }
}

function addition(record) {
  return record.sourceAddedAt || (record.baseline ? null : record.firstSeenAt);
}

function sortedRecords(index) {
  const records = Object.values(index.records);
  records.sort((a, b) => {
    const dateA = addition(a), dateB = addition(b);
    if (dateA !== dateB) return (dateB || '').localeCompare(dateA || '');
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return records;
}

function queryPage(index, extra = {}) {
  const revision = extra.revision === undefined ? index.revision : Number(extra.revision);
  let view = index.views?.[revision];
  if (!view && revision === index.revision) view = sortedRecords(index).map(record => ({ key: record.key, name: normalize(record.meta.name) }));
  if (!view) { const error = new Error('Recent revision expired. Restart pagination at skip=0'); error.code = 'RECENT_REVISION_EXPIRED'; throw error; }
  const search = normalize(String(extra.search || ''));
  const skip = Math.max(0, Math.trunc(Number(extra.skip) || 0));
  const records = view.filter(item => !search || item.name.includes(search)).slice(skip, skip + 100).map(item => index.records[item.key]);
  const metas = records.map(record => ({
    ...record.meta,
    firstSeenAt: record.firstSeenAt,
    addedAt: addition(record),
    addedAtSource: record.sourceAddedAt ? 'source' : record.baseline ? 'unknown' : 'firstSeen',
  }));
  return { metas, recentRevision: revision, recentUpdatedAt: index.updatedAt };
}

function queryIndex(index, extra = {}) { return queryPage(index, extra).metas; }

async function prepareSource(source, prior, pageBudget) {
  prior ||= { initialized: false, cursor: 100 };
  const state = { ...prior };
  const observations = [];
  const seen = new Set();
  let pages = 0;
  async function page(skip) {
    const items = await source.page(skip);
    if (!Array.isArray(items) || items.length > 100) throw new Error('Invalid catalog page');
    for (const item of items) {
      const token = `${item.meta.type}:${item.meta.id}`;
      if (seen.has(token)) continue;
      seen.add(token);
      observations.push({ ...item, baseline: !prior.initialized || skip > 0 });
    }
    pages++;
    return items.length;
  }
  const headSize = await page(0);
  if (headSize < 100) {
    state.initialized = true;
    state.cursor = 100;
  } else {
    let cursor = prior.cursor;
    while (pages < pageBudget) {
      const size = await page(cursor);
      if (size < 100) {
        state.initialized = true;
        state.cursor = 100;
        break;
      }
      cursor += 100;
      state.cursor = cursor;
    }
  }
  return { observations, state, stats: { pages, observed: observations.length, initialized: state.initialized } };
}

function commitSource(index, source, prepared, observedAt) {
  // A source commits as one transaction after every requested page succeeds.
  // Identity validation failure also preserves its prior records and cursor.
  const candidate = structuredClone(index);
  observe(candidate, source.key, prepared.observations, observedAt);
  candidate.sources[source.key] = { ...prepared.state, lastSuccessAt: observedAt, error: null };
  index.records = candidate.records;
  index.sources = candidate.sources;
  return prepared.stats;
}

async function scanSource(index, source, { observedAt, pageBudget = 3 } = {}) {
  return commitSource(index, source, await prepareSource(source, index.sources[source.key], pageBudget), observedAt);
}

async function updateIndex(index, sources, { now = Date.now, pageBudget = 3, concurrency = 2 } = {}) {
  if (!Number.isInteger(pageBudget) || pageBudget < 1 || pageBudget > 100 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('Invalid recent scan limits');
  const observedAt = new Date(now()).toISOString();
  const results = new Array(sources.length);
  let cursor = 0;
  // Fetch in bounded parallel batches, then apply in source order. This keeps
  // canonical routing deterministic when multiple lists expose the same ID.
  while (cursor < sources.length) {
    const batch = sources.slice(cursor, cursor + concurrency);
    const prepared = await Promise.allSettled(batch.map(source => prepareSource(source, index.sources[source.key], pageBudget)));
    for (let offset = 0; offset < prepared.length; offset++) {
      const source = batch[offset], result = prepared[offset];
      try {
        if (result.status === 'rejected') throw result.reason;
        results[cursor + offset] = commitSource(index, source, result.value, observedAt);
      } catch (error) {
        index.sources[source.key] = { ...(index.sources[source.key] || { initialized: false, cursor: 100 }), lastFailureAt: observedAt, error: String(error.message).slice(0, 300) };
        results[cursor + offset] = { error: error.message };
      }
    }
    cursor += concurrency;
  }
  index.revision++;
  index.updatedAt = observedAt;
  index.views ||= {};
  index.views[index.revision] = sortedRecords(index).map(record => ({ key: record.key, name: normalize(record.meta.name) }));
  for (const revision of Object.keys(index.views).map(Number).sort((a, b) => b - a).slice(12)) delete index.views[revision];
  return results;
}

module.exports = { emptyIndex, validateIndex, readIndex, writeIndex, withIndexLock, originalIdentity, observe, queryIndex, queryPage, scanSource, updateIndex };
