/**
 * Screenshot harness for the material showcase page (src/materials/demo.html).
 *
 * Same Chromium + SwiftShader flags as tools/shot.mjs, but it drives the
 * standalone demo instead of the game, so the materials can be judged without
 * touching anyone else's module.
 *
 *   node src/materials/shot-demo.mjs <label> [--poses=a,b] [--w=1280] [--h=720]
 *                                    [--size=512] [--wait=ms] [--boot=ms]
 *
 * Poses: sheet | far | rock | close:<surface> | props:<surface> | micro:<surface>
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT_DIR = process.env.SHOT_DIR || resolve(ROOT, 'shots');

const args = process.argv.slice(2);
const label = args.find((a) => !a.startsWith('--')) || 'materials';
const opt = (k, d) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const W = parseInt(opt('w', '1280'), 10);
const H = parseInt(opt('h', '720'), 10);
const SETTLE = parseInt(opt('wait', '900'), 10);
// SwiftShader is CPU rasterisation and several agents share 4 cores: boot is
// dominated by shader JIT, not by anything the materials do at runtime.
const BOOT = parseInt(opt('boot', '600000'), 10);
const SIZE = opt('size', '');
const POSES = opt('poses', 'sheet').split(',').filter(Boolean);

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const server = await createServer({
    root: ROOT,
    logLevel: 'error',
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
  });
  await server.listen();
  const port = server.config.server.port || server.httpServer.address().port;
  const url = `http://127.0.0.1:${port}/src/materials/demo.html${SIZE ? `?size=${SIZE}` : ''}`;

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: [
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
      '--enable-webgl', '--ignore-gpu-blocklist',
    ],
  });

  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors = [];
  const logs = [];
  page.on('pageerror', (e) => errors.push(String(e?.stack || e)));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') errors.push(t);
    else logs.push(t);
  });

  const report = { label, url, shots: [], errors, logs };
  const t0 = Date.now();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    // Fail fast on a page/module error instead of burning the whole boot budget.
    await page.waitForFunction(
      `window.__READY === true
       || (document.getElementById('err') && document.getElementById('err').style.display === 'block')
       || window.__BOOT_FAILED === true`,
      null, { timeout: BOOT, polling: 500 })
      .catch(() => errors.push(`TIMEOUT: __READY never set after ${BOOT}ms`));
    const fatal = await page.evaluate(
      () => document.getElementById('err')?.textContent || '').catch(() => '');
    if (fatal) errors.push(fatal.split('\n').slice(0, 6).join(' | '));
    report.bootMs = Date.now() - t0;
    await page.waitForTimeout(SETTLE);

    for (const p of POSES) {
      await page.evaluate((spec) => window.__DEMO?.pose(spec), p).catch(() => {});
      await page.waitForTimeout(SETTLE);
      const file = resolve(OUT_DIR, `${label}__${p.replace(/[:]/g, '-')}.png`);
      // SwiftShader frames can take many seconds; the 30 s default is not enough.
      await page.screenshot({ path: file, timeout: 180000 });
      report.shots.push(file);
    }
  } finally {
    await browser.close();
    await server.close();
  }

  writeFileSync(resolve(OUT_DIR, `${label}.json`), JSON.stringify(report, null, 2));
  console.log(`\n=== ${label} ===`);
  console.log('boot   :', report.bootMs, 'ms');
  for (const l of logs.slice(0, 12)) console.log('log    :', l.slice(0, 200));
  if (errors.length) {
    console.log(`errors (${errors.length}):`);
    for (const e of errors.slice(0, 10)) console.log('   ', e.split('\n').slice(0, 3).join(' | ').slice(0, 400));
  }
  console.log('shots  :\n         ' + report.shots.join('\n         '));
  process.exit(report.shots.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
