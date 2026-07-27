/**
 * Screenshot harness. Boots a throwaway Vite server on an ephemeral port,
 * renders the game in headless Chromium (SwiftShader), waits for the scene to
 * settle, and writes PNGs.
 *
 *   node tools/shot.mjs <label> [--shots=a,b,c] [--w=1600] [--h=900] [--wait=ms]
 *
 * Each agent can run this concurrently: the port is chosen by the OS, so
 * parallel runs do not collide.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT_DIR = process.env.SHOT_DIR || resolve(ROOT, 'shots');

const args = process.argv.slice(2);
const label = args.find((a) => !a.startsWith('--')) || 'shot';
const opt = (k, d) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const W = parseInt(opt('w', '1600'), 10);
const H = parseInt(opt('h', '900'), 10);
const SETTLE = parseInt(opt('wait', '2500'), 10);
const SHOTS = opt('shots', 'default').split(',').filter(Boolean);

/**
 * Named camera poses so successive runs frame the same thing and the critic
 * is comparing like with like. Each entry runs in page context.
 */
const POSES = {
  default: null,
  // Third-person-ish establishing shot of the map — shows off world + lighting.
  vista: { pos: [64, 46, 96], look: [0, 6, 0], fov: 70 },
  // Player eye-level down a street: reads texture detail and shadow contact.
  street: { pos: [12, 2.6, 34], look: [10, 2.2, -30], fov: 96 },
  // Close on a wall/prop to judge material detail at contact distance.
  material: { pos: [3.2, 1.7, 3.2], look: [0, 1.5, 0], fov: 55 },
  // Looking at the skyline/sun for atmosphere and bloom.
  sky: { pos: [0, 14, 0], look: [120, 40, 120], fov: 80 },
};

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const server = await createServer({
    root: ROOT,
    logLevel: 'error',
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
  });
  await server.listen();
  const port = server.config.server.port || server.httpServer.address().port;
  const url = `http://127.0.0.1:${port}/`;

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
  const warnings = [];
  page.on('pageerror', (e) => errors.push(String(e?.stack || e)));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') errors.push(t);
    else if (m.type() === 'warning') warnings.push(t);
  });

  const report = { label, url, shots: [], errors, warnings, loaded: [], failed: [], fps: null };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // SwiftShader compiles shaders on the CPU; boot is slow but bounded.
    await page.waitForFunction('window.__READY === true', null, { timeout: 120000 })
      .catch(() => errors.push('TIMEOUT: window.__READY never became true'));

    report.loaded = await page.evaluate(() => window.__LOADED || []).catch(() => []);
    report.failed = await page.evaluate(() => window.__FAILED || []).catch(() => []);

    await page.waitForTimeout(SETTLE);

    for (const shot of SHOTS) {
      const pose = POSES[shot];
      if (pose) {
        await page.evaluate((p) => {
          const e = window.__ENGINE;
          if (!e) return;
          const cam = e.camera;
          cam.position.set(...p.pos);
          cam.lookAt(...p.look);
          if (p.fov) { cam.fov = p.fov; cam.updateProjectionMatrix(); }
          // Freeze the player controller so it cannot snap the camera back.
          const pl = e.get('player');
          if (pl) pl.enabled = false;
        }, pose).catch(() => {});
        await page.waitForTimeout(600);
      }
      const path = resolve(OUT_DIR, `${label}__${shot}.png`);
      await page.screenshot({ path });
      report.shots.push(path);
    }

    report.fps = await page.evaluate(() => window.__ENGINE?.clock?.fps ?? null).catch(() => null);
    report.triangles = await page.evaluate(
      () => window.__ENGINE?.renderer?.info?.render?.triangles ?? null).catch(() => null);
    report.drawCalls = await page.evaluate(
      () => window.__ENGINE?.renderer?.info?.render?.calls ?? null).catch(() => null);
  } finally {
    await browser.close();
    await server.close();
  }

  writeFileSync(resolve(OUT_DIR, `${label}.json`), JSON.stringify(report, null, 2));

  console.log(`\n=== ${label} ===`);
  console.log('loaded :', report.loaded.join(', ') || '(none)');
  if (report.failed.length) {
    console.log('FAILED :');
    for (const f of report.failed) console.log(`   ${f.name}: ${f.error}`);
  }
  console.log('fps    :', report.fps?.toFixed?.(1) ?? 'n/a',
              '| tris:', report.triangles, '| calls:', report.drawCalls);
  if (errors.length) {
    console.log(`errors (${errors.length}):`);
    for (const e of errors.slice(0, 8)) console.log('   ', e.split('\n')[0].slice(0, 220));
  }
  console.log('shots  :', report.shots.join('\n         '));
  process.exit(errors.length && !report.shots.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
