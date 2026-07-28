/**
 * Scans every mesh's position attribute for NaN/Infinity.
 *
 * Non-finite vertices still rasterise -- often as huge screen-covering
 * triangles -- but raycasts against them fail, which produces the confusing
 * combination of "something is clearly drawn here" and "a ray through that
 * pixel hits nothing".
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROOT = '/home/user/shochan';
const server = await createServer({
  root: ROOT, logLevel: 'error', server: { port: 0, host: '127.0.0.1' },
});
await server.listen();
const port = server.config.server.port || server.httpServer.address().port;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__READY === true', null, { timeout: 240000 }).catch(() => {});

const rows = await page.evaluate(() => {
  const out = [];
  window.__ENGINE.scene.traverse((o) => {
    const g = o.geometry;
    if (!g?.attributes?.position) return;
    const p = g.attributes.position.array;
    let bad = 0, minY = Infinity, maxY = -Infinity, maxAbs = 0;
    for (let i = 0; i < p.length; i++) {
      const v = p[i];
      if (!Number.isFinite(v)) { bad++; continue; }
      if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
      if (i % 3 === 1) { if (v < minY) minY = v; if (v > maxY) maxY = v; }
    }
    if (bad > 0 || maxAbs > 3000) {
      out.push({ name: o.name || o.type, bad, count: p.length / 3,
        minY: Number.isFinite(minY) ? +minY.toFixed(1) : null,
        maxY: Number.isFinite(maxY) ? +maxY.toFixed(1) : null,
        maxAbs: +maxAbs.toFixed(0), visible: o.visible });
    }
  });
  return out;
});

if (!rows.length) console.log('GEOM: no non-finite vertices and nothing beyond 3000 units');
for (const r of rows) {
  console.log(`GEOM ${r.name} bad=${r.bad}/${r.count} y=[${r.minY},${r.maxY}] maxAbs=${r.maxAbs} visible=${r.visible}`);
}

await browser.close();
await server.close();
