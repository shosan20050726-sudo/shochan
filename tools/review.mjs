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
  // Poses are anchored to the POI pads in src/world/Layout.js. Keep them there
  // when the map changes, and let the free-space guard below catch the rest.
  {
    id: '01-vista',
    note: 'Map scale, atmospheric perspective, sky, distant silhouette read',
    pose: { pos: [118, 66, 128], look: [10, 6, -40], fov: 68 },
  },
  {
    id: '02-street',
    note: 'Eye level in Souk Plaza. Texture detail, shadow contact, mid-ground',
    pose: { pos: [46, 2.4, 42], look: [-4, 2.0, -6], fov: 96 },
  },
  {
    id: '03-material',
    note: 'Contact range on the Hangar 7 wall. Detail tiling, normals, edge wear',
    pose: { pos: [-56, 1.7, -116], look: [-56, 1.5, -148], fov: 50 },
  },
  {
    id: '04-sky',
    note: 'Sun, bloom, scattering, horizon haze — above the basin, clear of props',
    pose: { pos: [0, 44, 0], look: [170, 74, 130], fov: 78 },
  },
  {
    id: '05-lowangle',
    note: 'Low hero angle onto the Relay Spire. Silhouette against sky, specular',
    pose: { pos: [148, 1.4, 24], look: [196, 58, 6], fov: 88 },
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

/**
 * Wait for N *rendered frames*, not wall-clock time.
 *
 * Under SwiftShader a full-scene frame can take many seconds, so a fixed
 * sleep may not cover even one frame. Temporal effects (motion blur, TAA)
 * reproject from the previous frame's matrices, so screenshotting before the
 * camera teleport has been flushed through the history smears the whole
 * image and looks like a rendering bug when it is purely a capture artifact.
 */
async function waitFrames(page, n = 4, timeout = 300000) {
  const start = await page.evaluate(() => window.__ENGINE?.clock?.frame ?? 0).catch(() => 0);
  await page.waitForFunction(
    ([s, k]) => (window.__ENGINE?.clock?.frame ?? 0) >= s + k,
    [start, n], { timeout, polling: 250 },
  ).catch(() => {});
}

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
  // SwiftShader rasterises on the CPU; a full-scene frame can take minutes.
  page.setDefaultTimeout(300000);
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
    await waitFrames(page, 4);

    for (const f of FRAMES) {
      if (f.pose) {
        await page.evaluate((p) => {
          const e = window.__ENGINE; if (!e) return;
          const pl = e.get('player'); if (pl) pl.enabled = false;
          e.camera.position.set(...p.pos);
          e.camera.lookAt(...p.look);
          e.camera.fov = p.fov; e.camera.updateProjectionMatrix();
        }, f.pose).catch(() => {});

        // Guard: a pose authored against an older version of the map can end
        // up buried inside geometry, which fills the frame with the inside of
        // a prop and reads like a rendering bug. Lift the camera until it is
        // in free space and report it, rather than silently reviewing a shot
        // taken from inside a crate.
        const fix = await page.evaluate((p) => {
          const e = window.__ENGINE;
          const world = e.get('world');
          if (!world?.collision?.isFree) return null;
          const cam = e.camera;
          const probe = cam.position.clone();
          if (world.collision.isFree(probe, 0.35, 0.7)) return null;
          for (let i = 1; i <= 40; i++) {
            probe.y = p.pos[1] + i * 0.75;
            if (world.collision.isFree(probe, 0.35, 0.7)) {
              cam.position.copy(probe);
              cam.lookAt(...p.look);
              cam.updateMatrixWorld(true);
              return { liftedTo: Number(probe.y.toFixed(2)) };
            }
          }
          return { liftedTo: null };
        }, f.pose).catch(() => null);
        if (fix) {
          const msg = fix.liftedTo == null
            ? `POSE ${f.id}: camera inside geometry and no free space found above`
            : `POSE ${f.id}: camera was inside geometry, lifted to y=${fix.liftedTo}`;
          console.warn('  !', msg);
          report.poseWarnings ??= [];
          report.poseWarnings.push(msg);
        }

        await waitFrames(page, 5);
      }
      if (f.setup) await f.setup(page).catch(() => {});
      await waitFrames(page, 3);

      const path = resolve(OUT, `${f.id}.png`);
      await page.screenshot({ path, timeout: 300000 });
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
