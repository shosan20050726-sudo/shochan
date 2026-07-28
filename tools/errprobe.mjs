/**
 * Loop-liveness probe. Boots the game, records the engine frame counter, waits,
 * and records it again. A stalled counter means an exception escaped the
 * requestAnimationFrame callback and killed the render loop.
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
const disable = process.argv[2] || '';
const ringPart = process.argv[3] || 'both';
await page.addInitScript(([d, r]) => {
  window.__VFX_DISABLE = d; window.__RING_PART = r; window.__UI_DEMO = true;
}, [disable, ringPart]);

const errs = [];
page.on('pageerror', (e) => errs.push(String(e?.stack || e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__READY === true', null, { timeout: 240000 })
  .catch(() => errs.push('__READY timeout'));

const f1 = await page.evaluate(() => window.__ENGINE?.clock?.frame ?? -1);
await page.waitForTimeout(45000);
const f2 = await page.evaluate(() => window.__ENGINE?.clock?.frame ?? -1);

console.log(`[disable=${disable||'none'} ring=${ringPart}] frame after ready: ${f1} -> after 45s: ${f2}  ${f2 > f1 ? 'LOOP ALIVE' : 'LOOP DEAD'}`);
console.log('errors:');
for (const e of [...new Set(errs)].slice(0, 6)) {
  console.log('  ' + e.split('\n').slice(0, 5).join('\n  '));
}

await browser.close();
await server.close();
