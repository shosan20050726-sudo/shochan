/**
 * HUD screenshot harness — adapted from tools/shot.mjs.
 *
 * Boots the game with `window.__UI_DEMO = true` injected *before* any module
 * runs, so UISystem starts its self-test driver and the HUD comes up fully
 * populated (damage, kills, ring, abilities on cooldown).
 *
 *   node src/ui/ui-shot.mjs <label> [--w=1600] [--h=900] [--wait=ms] [--pause]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT_DIR = process.env.SHOT_DIR || resolve(ROOT, 'shots');

const args = process.argv.slice(2);
const label = args.find((a) => !a.startsWith('--')) || 'ui';
const opt = (k, d) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const flag = (k) => args.includes(`--${k}`);

const W = parseInt(opt('w', '1600'), 10);
const H = parseInt(opt('h', '900'), 10);
const SETTLE = parseInt(opt('wait', '700'), 10);

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  // HMR and the file watcher are disabled: other agents write into this repo
  // continuously and a stray full-reload would screenshot a booting page.
  const server = await createServer({
    root: ROOT, logLevel: 'error',
    server: {
      port: 0, strictPort: false, host: '127.0.0.1',
      hmr: false, watch: { ignored: ['**'] },
    },
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
  await page.addInitScript(() => { window.__UI_DEMO = true; });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e?.stack || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const report = { label, url, shots: [], errors, loaded: [], failed: [] };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction('window.__READY === true', null, { timeout: 120000 })
      .catch(() => errors.push('TIMEOUT: window.__READY never became true'));

    report.loaded = await page.evaluate(() => window.__LOADED || []).catch(() => []);
    report.failed = await page.evaluate(() => window.__FAILED || []).catch(() => []);
    report.demo = await page.evaluate(() => !!window.__HUD?.demo).catch(() => false);

    await page.waitForFunction(
      "document.getElementById('boot')?.classList.contains('hidden')", null, { timeout: 30000 })
      .catch(() => errors.push('boot overlay never hid'));

    // The software renderer runs at a few fps, so waiting in wall-clock time
    // barely advances the demo. Step it deterministically instead, then give
    // the CSS transitions real time to land.
    report.ff = await page.evaluate(() => window.__HUD?.fastForward?.(9) ?? null).catch(() => null);
    await page.waitForTimeout(SETTLE);
    // Stage the transient feedback that only lives for a few hundred ms.
    // One software frame is ~250ms, so the wait has to outlast a frame.
    await page.evaluate(() => {
      window.__HUD?.ctx.bus.emit('ui:hitmarker', { isHeadshot: true, isKill: false });
    }).catch(() => {});
    await page.waitForTimeout(380);

    const main = resolve(OUT_DIR, `${label}.png`);
    await page.screenshot({ path: main, timeout: 120000 });
    report.shots.push(main);

    // Second frame: incoming fire, which exercises the directional arcs, the
    // bar damage flash and the full-screen hit vignette.
    await page.evaluate(() => {
      const b = window.__HUD?.ctx.bus;
      if (!b) return;
      b.emit('damage:dealt', { targetId: 'player', amount: 23, shieldDamage: true, fromAngle: 2.2 });
      b.emit('damage:dealt', { targetId: 'player', amount: 11, shieldDamage: true, fromAngle: 5.4 });
    }).catch(() => {});
    await page.waitForTimeout(760);
    const b = resolve(OUT_DIR, `${label}__b.png`);
    await page.screenshot({ path: b, timeout: 120000 });
    report.shots.push(b);

    if (flag('downed')) {
      await page.evaluate(() => {
        const h = window.__HUD;
        if (h) { h.s.downed = true; h.s.health = 0; h.s.shield = 0; h.s.bleedTime = 26; }
      });
      await page.waitForTimeout(1500);
      const dpath = resolve(OUT_DIR, `${label}__downed.png`);
      await page.screenshot({ path: dpath, timeout: 120000 });
      report.shots.push(dpath);
    }

    if (flag('pause')) {
      // Park the render loop: a full-screen backdrop-filter cannot composite in
      // time on the software renderer while the 3D scene is still churning.
      await page.evaluate(() => window.__ENGINE?.stop?.()).catch(() => {});
      await page.waitForTimeout(400);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      report.escOpened = await page.evaluate(() => !!window.__HUD?.menu?.open).catch(() => false);
      if (!report.escOpened) {
        await page.evaluate(() => window.__HUD?.menu?.setOpen(true)).catch(() => {});
      }
      await page.waitForTimeout(1500);
      const m = resolve(OUT_DIR, `${label}__menu.png`);
      await page.screenshot({ path: m, timeout: 120000 });
      report.shots.push(m);
    }

    report.fps = await page.evaluate(() => window.__ENGINE?.clock?.fps ?? null).catch(() => null);
  } finally {
    await browser.close();
    await server.close();
  }

  writeFileSync(resolve(OUT_DIR, `${label}.json`), JSON.stringify(report, null, 2));
  console.log(`\n=== ${label} ===`);
  console.log('loaded :', report.loaded.join(', ') || '(none)');
  if (report.failed.length) for (const f of report.failed) console.log(`  FAILED ${f.name}: ${f.error}`);
  console.log('demo   :', report.demo, '| fps:', report.fps?.toFixed?.(1) ?? 'n/a');
  if (errors.length) {
    console.log(`errors (${errors.length}):`);
    for (const e of errors.slice(0, 10)) console.log('   ', e.split('\n')[0].slice(0, 240));
  }
  console.log('shots  :', report.shots.join('\n         '));
  process.exit(errors.length && !report.shots.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
