'use strict';
const BASE = 'https://ar.ifilmtv.ir';
const { normalize } = require('./kawthar');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
function entries(day, rows) {
  const date = String(day.strDate || '').slice(0, 10);
  if (!DATE.test(date) || !Array.isArray(rows)) throw new Error('Invalid iFilm schedule');
  const items = new Map();
  for (const row of rows) {
    if (!TIME.test(row.Time) || !row.Title || !Number.isSafeInteger(row.ItemId) || row.ItemId < 1) continue;
    // The official selector labels Time as Mecca (UTC+3). Build the date in
    // that zone, including midnight; GMT_Time alone belongs to the prior day.
    const start = Date.parse(`${date}T${row.Time}:00+03:00`);
    if (!Number.isFinite(start)) continue;
    const id = `ifilmar-schedule:${date}:${row.Time.replace(':', '')}:${row.ItemId}`;
    let poster;
    try { if (row.ImageLink) { const u = new URL(row.ImageLink, BASE); if (u.origin === BASE) poster = u.href; } } catch {}
    items.set(id, { id, type: 'tv', title: String(row.Title), time: row.Time, day: String(day.NameDayOfWeek || ''), date, start,
      name: `${date} ${row.Time} — ${row.Title}`, poster: poster || '/assets/live/ifilm.png', posterShape: 'landscape',
      description: `${day.NameDayOfWeek || ''} ${date}\n${row.Time} بتوقيت مكة المكرمة والبحرين (UTC+3)\n${row.Title}\n${row.Summary || ''}\n\nالتشغيل يفتح بث قناة آي فيلم المباشر.`, website: `${BASE}/Schedule` });
  }
  return [...items.values()].sort((a, b) => a.start - b.start);
}
async function request(path) {
  const u = new URL(path, BASE);
  if (u.origin !== BASE || !['/Schedule/PersionWeek', '/Schedule/GetItemInDay'].includes(u.pathname)) throw new Error('Invalid schedule upstream');
  const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(18000) });
  if (!r.ok) throw new Error(`iFilm schedule HTTP ${r.status}`);
  return r.json();
}
function createScheduleProvider(live, get = request, now = Date.now) {
  let cached, expires = 0, pending;
  async function load() {
    if (cached && expires > now()) return cached;
    if (pending) return pending;
    pending = (async () => {
      const days = await get('/Schedule/PersionWeek');
      if (!Array.isArray(days) || days.length > 14) throw new Error('Invalid schedule week');
      const batches = [];
      for (let offset = 0; offset < days.length; offset += 3) {
        batches.push(...await Promise.all(days.slice(offset, offset + 3).map(async day => {
          if (!DATE.test(String(day.strDate).slice(0, 10))) throw new Error('Invalid schedule date');
          const rows = await get('/Schedule/GetItemInDay?' + new URLSearchParams({ strDate: day.strDate }));
          return entries(day, rows);
        })));
      }
      const items = [...new Map(batches.flat().map(x => [x.id, x])).values()].sort((a, b) => a.start - b.start);
      cached = items; expires = now() + 300000; return items;
    })();
    try { return await pending; } finally { pending = undefined; }
  }
  function valid(type, id) { return type === 'tv' && /^ifilmar-schedule:\d{4}-\d{2}-\d{2}:\d{4}:\d+$/.test(id); }
  function meta(item, all) {
    const next = all.find(x => x.start > item.start);
    const state = now() < item.start ? 'قادم' : next ? (now() < next.start ? 'يعرض الآن' : 'موعد سابق') : 'بدأ موعده';
    const { title, start, time, day, date, ...m } = item;
    return { ...m, description: `${state}\n${m.description}`, releaseInfo: `${day} ${date} • ${time} (UTC+3)` };
  }
  return {
    async catalog(type, extra = {}) {
      if (type !== 'tv') return [];
      const all = await load(), search = normalize(extra.search), skip = Math.max(0, Number(extra.skip) || 0);
      return all.filter(x => !search || normalize(`${x.title} ${x.day} ${x.date} ${x.time}`).includes(search)).slice(skip, skip + 100).map(x => meta(x, all));
    },
    async detail(type, id) {
      if (!valid(type, id)) return null;
      const all = await load(), item = all.find(x => x.id === id);
      return item ? { meta: meta(item, all) } : null;
    },
    async streams(type, id) {
      if (!valid(type, id) || !(await load()).some(x => x.id === id)) return [];
      return (await live.streams('tv', 'ifilmar-live:ifilm')).map(x => ({ ...x, title: 'آي فيلم — البث المباشر للقناة' }));
    },
  };
}
module.exports = { createScheduleProvider, entries };
