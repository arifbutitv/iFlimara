const crypto = require('node:crypto');
const ROOT = 'https://raw.githubusercontent.com/arifbutitv/iFlimara/main/nuvio-addon/data/';
function validateContent(snapshot, sources, state) {
  if (!Array.isArray(snapshot?.series) || !Array.isArray(snapshot?.movies) || !/^[a-f0-9]{64}$/.test(state?.revision || '')) throw new Error('Invalid content index');
  const entries = [...snapshot.series, ...snapshot.movies];
  if (!entries.length || entries.length > 50000) throw new Error('Unexpected content index size');
  for (const video of entries) {
    if (!/^[A-Za-z0-9]{10,40}$/.test(video.id) || typeof video.title !== 'string' || new URL(video.url).origin !== 'https://shiatube.org') throw new Error('Invalid video entry');
    const hint = sources[video.id];
    if (!hint || !(hint.source || hint.iframe || hint.unavailable)) throw new Error('Missing playback reference');
  }
  for (const [id, hint] of Object.entries(sources)) {
    if (!/^[A-Za-z0-9]{10,40}$/.test(id) || !hint || typeof hint !== 'object') throw new Error('Invalid playback reference');
    for (const key of ['source', 'iframe']) if (hint[key]) {
      const url = new URL(hint[key], 'https://shiatube.org');
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid source protocol');
      const host = url.hostname;
      if (!(host === 'shiatube.org' || host.endsWith('.b-cdn.net') || host === 'ok.ru' || host === 'www.ok.ru' || host.endsWith('.okcdn.ru') || host === 'preview.presstv.ir' || host === 'preview.presstv.co.uk' || host.endsWith('.ifilmtv.ir') || host.endsWith('.archive.org') || host === 'video.alkawthartv.ir' || ['youtube.com', 'www.youtube.com', 'youtu.be', 'www.dailymotion.com', 'dailymotion.com'].includes(host))) throw new Error('Invalid source host');
    }
  }
  const digest = crypto.createHash('sha256').update(JSON.stringify(snapshot) + '\n' + JSON.stringify(sources)).digest('hex');
  if (digest !== state.revision) throw new Error('Content files do not match the published revision');
  return { snapshot, sources, state };
}
async function readRemoteContent(revision, get = fetch) {
  async function json(file, version) {
    const r = await get(ROOT + file + `?v=${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(12000), headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`Content index HTTP ${r.status}`);
    if (Number(r.headers.get('content-length')) > 40000000) throw new Error('Content index too large');
    return r.json();
  }
  const state = await json('shiatube-state.json', Math.floor(Date.now() / 600000));
  if (state.revision === revision) return null;
  const [snapshot, sources] = await Promise.all([json('shiatube.json', state.revision), json('shiatube-sources.json', state.revision)]);
  return validateContent(snapshot, sources, state);
}
module.exports = { readRemoteContent, validateContent };
