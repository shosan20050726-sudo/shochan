/**
 * Review-frame capture for the visual critic loop.
 *
 *   node tools/review.mjs <round>
 *
 * Captures a fixed set of framings at review resolution so successive rounds
 * are directly comparable. Frames are chosen to expose the things that
 * actually separate AAA from hobby work: silhouette/atmosphere at distance,
 * material detail at contact range, shadow contact, interior bounce light,
 * and a live gameplay frame with viewmodel + HUD + effects.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const round = process.argv[2] || 'r1';
const W = 1600, H = 900;
const OUT = resolve(ROOT, 'shots', `review-${round}`);

/**
 * Each frame: a camera pose plus an optional in-page setup step.
 * `setup` runs before the shot and may drive gameplay systems.
 */
const FRAMES = [
  {
    id: '01-vista',
    note: 'Map scale, atmospheric perspective, sky, distant silhouette read',
    pose: { pos: [70, 52, 110], look: [0, 4, -20], fov: 68 },
  },
  {
    id: '02-street',
    note: 'Eye level. Texture detail, shadow contact, mid-ground composition',
    pose: { pos: [14, 2.5, 40], look: [8, 2.0, -40], fov: 96 },
  },
  {
    id: '03-material',
    note: 'Contact range material read. Detail tiling, normal maps, edge wear',
    pose: { pos: [2.6, 1.6, 2.6], look: [0, 1.4, 0], fov: 50 },
  },
  {
    id: '04-sky',
    note: 'Sun, bloom, scattering, horizon haze',
    pose: { pos: [0, 18, 0], look: [140, 46, 140], fov: 78 },
  },
  {
    id: '05-lowangle',
    note: 'Low hero angle. Silhouette against sky, specular response',
    pose: { pos: [6, 0.7, 18], look: [2, 14, -14], fov: 88 },
  },
  {
    id: '06-gameplay',
    note: 'Live frame: viewmodel, HUD, VFX, the actual player POV',
    pose: null,
    setup: async (page) => {
      await page.evaluate(() => {
        const e = window.__ENGINE;
        if (!e) return;
        const pl = e.get('player');
        if (pl) pl.enabled = true;
        // Ask gameplay systems to present themselves if they support it.
        e.get('weapons')?.debugPresent?.();
        e.get('ai')?.debugPresent?.();
        e.get('vfx')?.debugPresent?.();
        e.get('ui')?.debugPresent?.();
        window.__UI_DEMO = true;
      });
      await page.waitForTimeout(1800);
    },
  },
];

async function main() {
  mkdirSync(OUT, { recursive: true });

  const server = await createServer({
    root: ROOT, logLevel: 'error',
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
  });
  await server.listen();
  const port = server.config.server.port || server.httpServer.address().port;

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
           '--enable-webgl', '--ignore-gpu-blocklist'],
  });

  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.addInitScript(() => { window.__UI_DEMO = true; });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e?.stack || e).split('\n').slice(0, 2).join(' | ')));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

  const report = { round, frames: [], errors, loaded: [], failed: [] };

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction('window.__READY === true', null, { timeout: 180000 })
      .catch(() => errors.push('TIMEOUT: __READY never true'));

    report.loaded = await page.evaluate(() => window.__LOADED || []).catch(() => []);
    report.failed = await page.evaluate(() => window.__FAILED || []).catch(() => []);
    await page.waitForTimeout(3000);

    for (const f of FRAMES) {
      if (f.pose) {
        await page.evaluate((p) => {
          const e = window.__ENGINE; if (!e) return;
          const pl = e.get('player'); if (pl) pl.enabled = false;
          e.camera.position.set(...p.pos);
          e.camera.lookAt(...p.look);
          e.camera.fov = p.fov; e.camera.updateProjectionMatrix();
        }, f.pose).catch(() => {});
        await page.waitForTimeout(900);
      }
      if (f.setup) await f.setup(page).catch(() => {});

      const path = resolve(OUT, `${f.id}.png`);
      await page.screenshot({ path });
      report.frames.push({ id: f.id, note: f.note, path });
    }

    report.fps = await page.evaluate(() => window.__ENGINE?.clock?.fps ?? null).catch(() => null);
    const info = await page.evaluate(() => {
      const r = window.__ENGINE?.renderer?.info;
      return r ? { tris: r.render.triangles, calls: r.render.calls, textures: r.memory.textures, geometries: r.memory.geometries } : null;
    }).catch(() => null);
    report.renderInfo = info;
  } finally {
    await browser.close();
    await server.close();
  }

  writeFileSync(resolve(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n=== REVIEW ${round} ===`);
  console.log('loaded :', report.loaded.join(', ') || '(none)');
  if (report.failed.length) for (const f of report.failed) console.log('  FAILED', f.name, '-', f.error);
  console.log('render :', JSON.stringify(report.renderInfo));
  if (errors.length) {
    console.log(`errors (${errors.length}):`);
    for (const e of [...new Set(errors)].slice(0, 10)) console.log('   ', e.slice(0, 200));
  }
  console.log('frames :');
  for (const f of report.frames) console.log('   ', f.path);
  console.log('\nOUT DIR:', OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
