/**
 * In-browser smoke test: boots the real game in headless Chromium and drives
 * the real PlayerSystem against whatever geometry the world system actually
 * built. The pure-maths suite (physics.test.mjs) proves the model; this proves
 * the integration — BVH bake time, spawn placement, and that the controller
 * survives the live world.
 *
 *   node src/physics/browser.test.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const DRIVE = ({ mx, mz, jump, crouch, sprint, ticks, yawRate }) => {
  const p = window.__ENGINE.get('player');
  const ctx = window.__ENGINE.ctx;
  const dt = window.__ENGINE.cfg.time.fixedStep;
  let minY = Infinity, maxSpeed = 0;
  for (let i = 0; i < ticks; i++) {
    p.setInput(mx, mz, jump, crouch, sprint);
    if (yawRate) p.rig.yaw += yawRate * dt;
    p.fixedUpdate(dt, ctx);
    minY = Math.min(minY, p.position.y);
    maxSpeed = Math.max(maxSpeed, p.speed);
  }
  return {
    x: p.position.x, y: p.position.y, z: p.position.z,
    speed: p.speed, onGround: p.onGround, sliding: p.isSliding,
    minY, maxSpeed, tris: p.collision.triangleCount,
    buildMs: p.collision.bvh.buildMs,
    eyeY: p.eyePosition.y, camY: ctx.camera.position.y,
  };
};

async function main() {
  const server = await createServer({
    root: ROOT, logLevel: 'error',
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
  });
  await server.listen();
  const port = server.config.server.port || server.httpServer.address().port;
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e?.message || e)));

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction('window.__READY === true', null, { timeout: 120000 });

    const boot = await page.evaluate(() => {
      const p = window.__ENGINE.get('player');
      return {
        exists: !!p, name: p?.name, priority: p?.priority,
        tris: p?.collision?.triangleCount, buildMs: p?.collision?.bvh?.buildMs,
        pos: p ? [p.position.x, p.position.y, p.position.z] : null,
        onGround: p?.onGround,
        api: p ? ['position', 'velocity', 'onGround', 'isSliding', 'isSprinting',
          'eyePosition', 'speed', 'enabled'].filter((k) => p[k] === undefined) : null,
      };
    });
    console.log('\nboot');
    check('player system registered', boot.exists && boot.name === 'player' && boot.priority === 20,
      `name=${boot.name} priority=${boot.priority}`);
    check('BVH baked from the real world', boot.tris > 0,
      `${boot.tris} triangles in ${boot.buildMs?.toFixed(1)} ms`);
    check('required public API is present', boot.api && boot.api.length === 0,
      boot.api?.length ? `missing: ${boot.api.join(', ')}` : 'all present');
    check('spawned on solid ground', boot.onGround === true,
      `pos=(${boot.pos.map((v) => v.toFixed(2)).join(', ')}) onGround=${boot.onGround}`);

    console.log('\nlive movement');
    const walk = await page.evaluate(DRIVE, { mx: 0, mz: 1, jump: false, crouch: false, sprint: true, ticks: 360 });
    check('sprints across the real map', walk.speed > 5 && walk.minY > -1,
      `speed=${walk.speed.toFixed(2)} pos=(${walk.x.toFixed(1)}, ${walk.y.toFixed(1)}, ${walk.z.toFixed(1)}) minY=${walk.minY.toFixed(2)}`);

    const hop = await page.evaluate(DRIVE, { mx: -1, mz: 1, jump: true, crouch: false, sprint: true, ticks: 360, yawRate: 1.2 });
    check('bhop + air-strafe stays above the floor', hop.minY > -1 && hop.maxSpeed > 5,
      `maxSpeed=${hop.maxSpeed.toFixed(2)} minY=${hop.minY.toFixed(2)}`);

    const slide = await page.evaluate(DRIVE, { mx: 0, mz: 1, jump: false, crouch: true, sprint: true, ticks: 240 });
    check('slide runs without breaking', Number.isFinite(slide.speed) && slide.minY > -1,
      `speed=${slide.speed.toFixed(2)} sliding=${slide.sliding}`);

    const camOk = await page.evaluate(() => {
      const e = window.__ENGINE, p = e.get('player');
      p.update(1 / 60, 1, e.ctx);
      const c = e.camera;
      return {
        finite: [c.position.x, c.position.y, c.position.z, c.fov].every(Number.isFinite),
        dy: Math.abs(c.position.y - (p.position.y + p.eyeHeight)),
        fov: c.fov,
      };
    });
    check('camera driven and finite', camOk.finite && camOk.dy < 0.35,
      `eye offset err=${camOk.dy.toFixed(3)} fov=${camOk.fov.toFixed(1)}`);

    const frozen = await page.evaluate(() => {
      const e = window.__ENGINE, p = e.get('player');
      p.enabled = false;
      e.camera.position.set(1, 2, 3);
      const before = [p.position.x, p.position.y, p.position.z];
      for (let i = 0; i < 120; i++) { p.fixedUpdate(1 / 120, e.ctx); p.update(1 / 120, 1, e.ctx); }
      const cam = e.camera.position;
      p.enabled = true;
      return {
        moved: Math.abs(p.position.x - before[0]) + Math.abs(p.position.y - before[1]) + Math.abs(p.position.z - before[2]),
        cam: [cam.x, cam.y, cam.z],
      };
    });
    check('enabled=false freezes body and camera',
      frozen.moved < 1e-9 && frozen.cam[0] === 1 && frozen.cam[1] === 2 && frozen.cam[2] === 3,
      `moved=${frozen.moved} cam=(${frozen.cam.join(', ')})`);

    const proj = await page.evaluate(() => {
      const e = window.__ENGINE, p = e.get('player');
      let hits = 0;
      for (let i = 0; i < 24; i++) {
        p.projectiles.spawn({
          x: p.eyePosition.x, y: p.eyePosition.y, z: p.eyePosition.z,
          dx: Math.cos(i), dy: -0.15, dz: Math.sin(i), speed: 850, drag: 0.001,
          onHit: () => { hits++; },
        });
      }
      for (let i = 0; i < 240; i++) p.projectiles.fixedUpdate(1 / 120);
      const rd = p.ragdolls.spawn(p.position, { vx: 2, vy: 2, vz: 0 });
      for (let i = 0; i < 300; i++) p.ragdolls.fixedUpdate(1 / 120);
      const c = new (Object.getPrototypeOf(p.position).constructor)();
      rd.center(c);
      return { hits, live: p.projectiles.count, ragdollY: c.y, ragdollOk: Number.isFinite(c.y) };
    });
    check('projectiles hit real world geometry', proj.hits > 0 && proj.live === 0,
      `${proj.hits}/24 hit, ${proj.live} still live`);
    check('ragdoll simulates against real geometry', proj.ragdollOk,
      `centre y=${proj.ragdollY.toFixed(2)}`);

    check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
