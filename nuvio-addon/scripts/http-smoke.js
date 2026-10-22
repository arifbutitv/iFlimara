const assert = require('node:assert/strict');
const app = require('../server');
const server = app.listen(0, '127.0.0.1');
server.once('listening', async () => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const paths = [
      '/manifest.json',
      '/catalog/series/ifilmar-series.json',
      '/catalog/movie/ifilmar-movie.json',
      `/catalog/series/ifilmar-series/search=${encodeURIComponent('العاصمة')}.json`,
      '/meta/series/ifilmar:series:74467.json',
      '/stream/series/ifilmar:series:74467:1:1.json',
      '/stream/movie/ifilmar:movie:74595.json',
    ];
    for (const path of paths) {
      const res = await fetch(origin + path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      const body = await res.json();
      if (path.includes('/catalog/')) assert.ok(body.metas.length > 0, path);
      if (path.includes('/meta/')) assert.ok(body.meta.videos.length > 0, path);
      if (path.includes('/stream/')) assert.ok(body.streams.length > 0, path);
      console.log(`HTTP OK: ${path}`);
    }
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    server.closeAllConnections();
    server.close();
  }
});
