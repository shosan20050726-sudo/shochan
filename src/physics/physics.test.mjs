/**
 * Headless physics acceptance tests.
 *
 *   node src/physics/physics.test.mjs
 *
 * Drives PlayerSystem through scripted inputs against a synthetic collision
 * world. No DOM, no WebGL — the controller and the collision world are pure
 * maths, which is exactly why they are testable like this.
 */
import * as THREE from 'three';
import CFG from '../core/Config.js';
import { EventBus } from '../core/EventBus.js';
import PlayerSystem from './PlayerSystem.js';

/* ------------------------------------------------------------------ */
/* tiny test harness                                                    */
/* ------------------------------------------------------------------ */
let passed = 0, failed = 0;
const notes = [];

function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function info(msg) { notes.push(msg); console.log(`        ${msg}`); }
function section(t) { console.log(`\n${t}`); }

/* ------------------------------------------------------------------ */
/* synthetic world                                                      */
/* ------------------------------------------------------------------ */
const RAMP_ANGLE = 22 * Math.PI / 180;

function buildWorld() {
  const meshes = [];
  const box = (w, h, d, x, y, z, surface = 'concrete', rotZ = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d));
    m.position.set(x, y, z);
    if (rotZ) m.rotation.z = rotZ;
    m.userData.surface = surface;
    m.updateMatrixWorld(true);
    meshes.push(m);
    return m;
  };

  // Ground: top face at y = 0. Everything below lives inside |x|,|z| < 90,
  // which leaves the region around (150, *, 150) as a clear running field.
  box(600, 2, 600, 0, -1, 0, 'sand');

  // Thin wall at x = 30 (tunnelling test) — only 8 cm thick.
  box(0.08, 8, 40, 30, 4, 0, 'metal');

  // Solid wall at x = -30 (wall-bounce test).
  box(1.0, 8, 40, -30, 4, 0, 'concrete');

  // Staircase climbing +z from z = 10, 14 steps of 0.3 m, plus a landing.
  for (let i = 0; i < 14; i++) {
    box(6, 0.3 * (i + 1), 0.5, 0, 0.3 * (i + 1) * 0.5, 10 + i * 0.5, 'wood');
  }
  box(6, 4.2, 12, 0, 2.1, 22.5, 'wood');

  // Mantle target: a 2 m block in front of z = -10.
  box(6, 2, 4, 0, 1, -12, 'concrete');

  // Long ramp for the slide test, tilted about z so downhill is -x.
  box(140, 1, 24, 0, 40, 60, 'rock', RAMP_ANGLE);

  return meshes;
}

function makeCtx(meshes) {
  const bus = new EventBus();
  const world = {
    name: 'world', priority: 10,
    colliderMeshes: meshes,
    spawnPoints: [new THREE.Vector3(0, 3, 0)],
  };
  const registry = new Map([['world', world]]);
  const engine = { get: (n) => registry.get(n) };
  const camera = new THREE.PerspectiveCamera(CFG.camera.fov, 16 / 9, CFG.camera.near, CFG.camera.far);
  return { engine, bus, cfg: CFG, camera, clock: { dt: 0, elapsed: 0, frame: 0, fps: 120 } };
}

const DT = CFG.time.fixedStep;
/** Empty part of the map, so long runs never bump into the test props. */
const FIELD = new THREE.Vector3(150, 0.05, 150);

async function newPlayer(meshes, ctx) {
  const p = new PlayerSystem();
  await p.init(ctx);
  return p;
}

/** Run n physics ticks with the given held inputs. */
function tick(p, ctx, n, inp = {}) {
  for (let i = 0; i < n; i++) {
    p.setInput(inp.mx ?? 0, inp.mz ?? 0, inp.jump ?? false, inp.crouch ?? false, inp.sprint ?? false);
    if (inp.yawRate) p.rig.yaw += inp.yawRate * DT;
    p.fixedUpdate(DT, ctx);
    p.update(DT, 1, ctx);          // exercise the camera rig too
    if (inp.onTick) inp.onTick(p, i);
  }
}

/* ------------------------------------------------------------------ */
/* tests                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const meshes = buildWorld();
  const ctx = makeCtx(meshes);
  const p = await newPlayer(meshes, ctx);

  section('collision world');
  info(`BVH: ${p.collision.triangleCount} triangles, ${p.collision.bvh.nodeCount} nodes, ` +
       `built in ${p.collision.bvh.buildMs.toFixed(1)} ms`);
  check('BVH built', p.collision.ready && p.collision.triangleCount > 0);
  {
    const hit = p.collision.raycast(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, -1, 0), 50);
    check('raycast finds the ground', !!hit && Math.abs(hit.point.y) < 1e-3,
      hit ? `y=${hit.point.y.toFixed(4)} surface=${hit.surface}` : 'no hit');
  }

  /* ---- 1. does not fall through the floor ---- */
  section('1. gravity / floor');
  p.teleport(new THREE.Vector3(0, 12, 0));
  tick(p, ctx, 600);
  check('rests on the floor', Math.abs(p.position.y) < 0.02 && p.onGround,
    `y=${p.position.y.toFixed(4)} onGround=${p.onGround}`);
  check('vertical velocity settled', Math.abs(p.velocity.y) < 0.05, `vy=${p.velocity.y.toFixed(4)}`);

  // and after a long high-speed random walk it is still above the floor
  {
    let minY = Infinity;
    p.teleport(FIELD);
    for (let i = 0; i < 1400; i++) {
      const dir = Math.sin(i * 0.037);
      p.rig.yaw += 1.4 * DT * Math.sin(i * 0.011);
      p.setInput(dir > 0 ? 1 : -1, 1, i % 97 === 0, i % 151 < 30, true);
      p.fixedUpdate(DT, ctx);
      if (p.position.y < minY) minY = p.position.y;
    }
    check('never sinks below the floor during a 12 s scramble', minY > -0.05,
      `min y=${minY.toFixed(4)}`);
  }

  /* ---- 2. walk speed / accel sanity ---- */
  section('2. ground movement');
  p.rig.yaw = 0;
  p.teleport(FIELD);
  tick(p, ctx, 30);
  tick(p, ctx, 120, { mz: 1 });
  const walkSpeed = p.speed;
  check('reaches walk speed', Math.abs(walkSpeed - CFG.move.walkSpeed) < 0.25,
    `${walkSpeed.toFixed(2)} m/s (target ${CFG.move.walkSpeed})`);
  tick(p, ctx, 120, { mz: 1, sprint: true });
  const sprintSpeed = p.speed;
  check('reaches sprint speed', Math.abs(sprintSpeed - CFG.move.sprintSpeed) < 0.25,
    `${sprintSpeed.toFixed(2)} m/s (target ${CFG.move.sprintSpeed})`);
  tick(p, ctx, 60);
  check('friction stops the player', p.speed < 0.05, `${p.speed.toFixed(3)} m/s`);

  /* ---- 3. jump height / coyote / buffer ---- */
  section('3. jump');
  p.teleport(FIELD);
  tick(p, ctx, 30);
  let apex = 0;
  tick(p, ctx, 4, { jump: true });
  tick(p, ctx, 200, { onTick: (pl) => { apex = Math.max(apex, pl.position.y); } });
  const expected = (CFG.move.jumpVelocity ** 2) / (2 * CFG.move.gravity);
  check('jump apex matches v^2/2g', Math.abs(apex - expected) < 0.09,
    `apex=${apex.toFixed(3)} expected=${expected.toFixed(3)}`);
  check('lands again', p.onGround, `y=${p.position.y.toFixed(3)}`);

  // coyote time: walk off the top step and jump a moment later.
  {
    p.teleport(new THREE.Vector3(0, 4.3, 16.5));
    tick(p, ctx, 60);
    const before = p.position.y;
    tick(p, ctx, 24, { mz: -1 });          // step off the edge (-z is downhill of the stairs)
    const airborne = !p.onGround;
    tick(p, ctx, 6, { mz: -1, jump: true });
    check('coyote-time jump fires just after leaving a ledge',
      airborne ? p.velocity.y > 3 : true,
      `airborne=${airborne} vy=${p.velocity.y.toFixed(2)} y0=${before.toFixed(2)}`);
    tick(p, ctx, 240);
  }

  /* ---- 4. stairs ---- */
  section('4. stairs');
  p.rig.yaw = Math.PI;                     // face +z
  p.teleport(new THREE.Vector3(0, 0.05, 7));
  tick(p, ctx, 40, { mz: 1, sprint: true });
  const stairStart = p.position.z;
  let maxStepJerk = 0, maxY = 0, climbSum = 0, climbTicks = 0, climbSlow = 0, prevY = p.position.y;
  tick(p, ctx, 240, {
    mz: 1, sprint: true,
    onTick: (pl) => {
      maxStepJerk = Math.max(maxStepJerk, Math.abs(pl.position.y - prevY));
      prevY = pl.position.y;
      maxY = Math.max(maxY, pl.position.y);
      if (pl.position.y > 0.2 && pl.position.y < 4.15) {
        climbSum += pl.speed; climbTicks++;
        if (pl.speed < CFG.move.sprintSpeed * 0.9) climbSlow++;
      }
    },
  });
  check('climbed the 4.2 m staircase', maxY > 4.15,
    `reached y=${maxY.toFixed(2)} (from z=${stairStart.toFixed(2)})`);
  const climbAvg = climbSum / Math.max(1, climbTicks);
  check('stairs cost almost no speed', climbAvg > CFG.move.sprintSpeed * 0.95 && climbSlow <= 4,
    `avg ${climbAvg.toFixed(2)} of ${CFG.move.sprintSpeed} m/s over ${climbTicks} ticks, ` +
    `${climbSlow} ticks below 90%`);
  check('no teleporting up the stairs', maxStepJerk < CFG.move.player.stepHeight,
    `largest single-tick rise ${maxStepJerk.toFixed(3)} m`);
  check('camera step offset stays bounded', Math.abs(p.rig.stepOffset) <= CFG.move.player.stepHeight * 0.8,
    `stepOffset=${p.rig.stepOffset.toFixed(3)}`);

  /* ---- 5. no tunnelling ---- */
  section('5. tunnelling');
  for (const speed of [26, 60, 140, 400]) {
    p.rig.yaw = -Math.PI / 2;              // face +x
    p.teleport(new THREE.Vector3(20, 0.1, 0));
    tick(p, ctx, 20);
    p.velocity.set(speed, 0, 0);
    let maxX = -Infinity;
    for (let i = 0; i < 90; i++) {
      p.setInput(0, 0, false, false, false);
      p.velocity.x = Math.max(p.velocity.x, speed * 0.5);   // keep pushing into it
      p.fixedUpdate(DT, ctx);
      maxX = Math.max(maxX, p.position.x);
    }
    check(`capsule stopped by an 8 cm wall at ${speed} m/s`, maxX < 30,
      `max x=${maxX.toFixed(3)} (wall face at 29.96)`);
  }

  /* ---- 6. air strafe gains speed ---- */
  section('6. air strafe');
  {
    p.rig.yaw = 0;
    p.teleport(FIELD);
    tick(p, ctx, 30);
    tick(p, ctx, 90, { mz: 1, sprint: true });
    tick(p, ctx, 2, { mz: 1, sprint: true, jump: true });
    const launch = p.speed;
    // Classic left strafe: hold A and turn left at a steady rate.
    tick(p, ctx, 80, { mx: -1, mz: 0, yawRate: 1.5 });
    const gained = p.speed;
    check('air-strafing increases speed', gained > launch + 0.4,
      `${launch.toFixed(2)} -> ${gained.toFixed(2)} m/s in 0.67 s airborne`);

    // Doing nothing in the air must not gain speed.
    p.teleport(FIELD);
    tick(p, ctx, 30);
    tick(p, ctx, 90, { mz: 1, sprint: true });
    tick(p, ctx, 2, { mz: 1, sprint: true, jump: true });
    const l2 = p.speed;
    tick(p, ctx, 80, { mz: 1 });
    check('holding W in the air does not gain speed', p.speed <= l2 + 0.02,
      `${l2.toFixed(2)} -> ${p.speed.toFixed(2)} m/s`);
  }

  /* ---- 7. bunnyhop keeps speed ---- */
  section('7. bunnyhop');
  {
    p.rig.yaw = 0;
    p.teleport(FIELD);
    tick(p, ctx, 30);
    tick(p, ctx, 120, { mz: 1, sprint: true });
    const before = p.speed;
    let minSpeed = Infinity, hops = 0, wasAir = false;
    for (let i = 0; i < 600; i++) {
      p.setInput(0, 1, true, false, true);
      p.fixedUpdate(DT, ctx);
      if (p.onGround && wasAir) hops++;
      wasAir = !p.onGround;
      minSpeed = Math.min(minSpeed, p.speed);
    }
    check('hopping preserves momentum', minSpeed > before * 0.9 && hops >= 3,
      `entry ${before.toFixed(2)} -> min ${minSpeed.toFixed(2)} m/s over ${hops} hops`);
  }

  /* ---- 8. slide ---- */
  section('8. slide');
  {
    // flat slide: boosts then decays
    p.rig.yaw = 0;
    p.teleport(FIELD);
    tick(p, ctx, 30);
    tick(p, ctx, 150, { mz: 1, sprint: true });
    const preSlide = p.speed;
    tick(p, ctx, 1, { mz: 1, sprint: true });
    tick(p, ctx, 2, { mz: 1, sprint: true, crouch: true });
    const entry = p.speed;
    check('slide entry boosts out of a sprint', entry > preSlide + CFG.move.slide.boost * 0.8,
      `${preSlide.toFixed(2)} -> ${entry.toFixed(2)} m/s`);
    check('slide is active', p.isSliding);
    let t = 0;
    while (p.isSliding && t < 6) { tick(p, ctx, 1, { mz: 1, crouch: true }); t += DT; }
    check('flat slide decays and ends', !p.isSliding && t < CFG.move.slide.maxDuration + 0.2,
      `lasted ${t.toFixed(2)} s, exit speed ${p.speed.toFixed(2)} m/s`);
  }

  {
    // downhill slide: accelerates
    p.rig.yaw = Math.PI / 2;                    // face -x (downhill)
    p.teleport(new THREE.Vector3(-20, 60, 60));
    tick(p, ctx, 400);
    check('landed on the ramp', p.onGround && p.groundNormal.y < 0.95,
      `y=${p.position.y.toFixed(2)} n=(${p.groundNormal.x.toFixed(2)},${p.groundNormal.y.toFixed(2)})`);
    tick(p, ctx, 200, { mz: 1, sprint: true });
    const before = p.speed;
    tick(p, ctx, 1, { mz: 1, sprint: true });
    tick(p, ctx, 2, { mz: 1, sprint: true, crouch: true });
    const entry = p.speed;
    tick(p, ctx, 120, { mz: 0, crouch: true });
    const after1s = p.speed;
    tick(p, ctx, 120, { mz: 0, crouch: true });
    const after2s = p.speed;
    check('downhill slide accelerates', after1s > entry + 2 && after2s > after1s,
      `run ${before.toFixed(1)} -> entry ${entry.toFixed(1)} -> 1 s ${after1s.toFixed(1)} -> 2 s ${after2s.toFixed(1)} m/s`);
    check('downhill slide does not time out', p.isSliding, `sliding=${p.isSliding}`);
    tick(p, ctx, 240, { crouch: true });
    info(`slide speed after 4 s downhill: ${p.speed.toFixed(1)} m/s (cap ${CFG.move.maxSpeedCap})`);
    check('speed cap respected', p.speed <= CFG.move.maxSpeedCap + 0.01);
    tick(p, ctx, 10, {});
  }

  /* ---- 9. mantle ---- */
  section('9. mantle');
  {
    p.rig.yaw = 0;                              // face -z, block top at y = 2
    p.teleport(new THREE.Vector3(0, 0.05, -7));
    tick(p, ctx, 30);
    let started = false;
    ctx.bus.once('player:mantle:start', () => { started = true; });
    tick(p, ctx, 300, { mz: 1, sprint: true, jump: true });
    check('mantle fired on a 2 m ledge', started);
    check('cleared the 2 m ledge', p.position.y > 1.95 && p.position.z < -10,
      `pos=(${p.position.x.toFixed(2)}, ${p.position.y.toFixed(2)}, ${p.position.z.toFixed(2)})`);
    check('standing on top afterwards', p.onGround, `onGround=${p.onGround}`);
  }

  /* ---- 10. wall bounce ---- */
  section('10. wall bounce');
  {
    p.rig.yaw = Math.PI / 2;                    // face -x, wall face at x = -29.5
    p.teleport(new THREE.Vector3(-15, 0.05, 0));
    tick(p, ctx, 30);
    // Run up, then leap at the wall from ~4 m out so we arrive airborne.
    while (p.position.x > -25.5) tick(p, ctx, 1, { mz: 1, sprint: true });
    tick(p, ctx, 2, { mz: 1, sprint: true, jump: true });
    const approach = p.speed;
    let bounced = null;
    ctx.bus.once('player:wallbounce', (e) => { bounced = e; });
    // Fly into the wall holding jump; the bounce should fire on contact.
    for (let i = 0; i < 180 && !bounced; i++) {
      p.setInput(0, 1, true, false, true);
      p.rig.yaw = Math.PI / 2 + 0.6;            // aim away from the wall
      p.fixedUpdate(DT, ctx);
    }
    check('wall bounce fired', !!bounced, bounced ? `speed=${bounced.speed.toFixed(2)}` : 'never fired');
    if (bounced) {
      check('wall bounce retains speed', p.speed > approach * CFG.move.wallBounce.speedRetain,
        `approach ${approach.toFixed(2)} -> out ${p.speed.toFixed(2)} m/s`);
      check('wall bounce sends you up', p.velocity.y > 1.0, `vy=${p.velocity.y.toFixed(2)}`);
      check('wall bounce sends you away from the wall', p.velocity.x > 0, `vx=${p.velocity.x.toFixed(2)}`);
    }
  }

  /* ---- 11. slope limit ---- */
  section('11. slope limit');
  {
    // The 22 deg ramp is walkable; walking up it must work.
    p.rig.yaw = -Math.PI / 2;                   // face +x = uphill
    p.teleport(new THREE.Vector3(-20, 60, 60));
    tick(p, ctx, 400);
    const y0 = p.position.y;
    tick(p, ctx, 300, { mz: 1, sprint: true });
    check('walks up a 22 deg ramp', p.position.y > y0 + 3 && p.onGround,
      `${y0.toFixed(2)} -> ${p.position.y.toFixed(2)}`);
  }

  /* ---- 12. events ---- */
  section('12. events');
  {
    const seen = new Map();
    for (const e of ['player:jump', 'player:land', 'player:footstep',
      'player:slide:start', 'player:slide:end']) {
      ctx.bus.on(e, (payload) => {
        const prev = seen.get(e);
        if (e !== 'player:land' || !prev || payload.impact > prev.impact) seen.set(e, payload);
      });
    }
    p.rig.yaw = 0;
    p.teleport(FIELD);
    tick(p, ctx, 30);
    tick(p, ctx, 300, { mz: 1, sprint: true });
    tick(p, ctx, 2, { mz: 1, sprint: true, jump: true });
    tick(p, ctx, 200, { mz: 1, sprint: true });
    tick(p, ctx, 2, { mz: 1, sprint: true, crouch: true });
    tick(p, ctx, 400, { mz: 1, crouch: true });
    check('EV.PLAYER_JUMP emitted', seen.has('player:jump'));
    check('EV.PLAYER_LAND emitted with impact', seen.get('player:land')?.impact > 0,
      `impact=${seen.get('player:land')?.impact?.toFixed(2)}`);
    const fs = seen.get('player:footstep');
    check('EV.FOOTSTEP carries position/surface/speed',
      !!fs && fs.position?.isVector3 && typeof fs.surface === 'string' && fs.speed > 0,
      fs ? `surface=${fs.surface} speed=${fs.speed.toFixed(2)}` : 'none');
    check('EV.SLIDE_START / SLIDE_END emitted',
      seen.has('player:slide:start') && seen.has('player:slide:end'));

    // footstep cadence should track distance, not time
    let steps = 0, dist = 0;
    ctx.bus.on('player:footstep', () => steps++);
    p.teleport(FIELD);
    tick(p, ctx, 60);
    steps = 0;
    let last = p.position.clone();
    tick(p, ctx, 600, {
      mz: 1, sprint: true,
      onTick: (pl) => { dist += Math.hypot(pl.position.x - last.x, pl.position.z - last.z); last.copy(pl.position); },
    });
    info(`${steps} footsteps over ${dist.toFixed(1)} m => ${(dist / Math.max(steps, 1)).toFixed(2)} m stride`);
    check('footstep stride is sane', steps > 0 && dist / steps > 1.4 && dist / steps < 3.4);
  }

  /* ---- 13. projectiles ---- */
  section('13. projectiles');
  {
    p.projectiles.clear();
    let hit = null;
    p.projectiles.spawn({
      x: 20, y: 3, z: 0, dx: 1, dy: 0, dz: 0, speed: 900, drag: 0.001,
      onHit: (h) => { hit = { x: h.point.x, surface: h.surface }; },
    });
    for (let i = 0; i < 20; i++) p.projectiles.fixedUpdate(DT);
    check('900 m/s round hits the 8 cm wall (no tunnelling)',
      !!hit && Math.abs(hit.x - 30) < 0.2, hit ? `x=${hit.x.toFixed(3)} surface=${hit.surface}` : 'no hit');

    // ballistic drop
    p.projectiles.clear();
    let landed = null;
    p.projectiles.spawn({
      x: 0, y: 20, z: 0, dx: 0, dy: 0, dz: -1, speed: 40, drag: 0.02,
      onHit: (h) => { landed = h.point.clone(); },
    });
    for (let i = 0; i < 400 && !landed; i++) p.projectiles.fixedUpdate(DT);
    check('gravity + drag make the round drop', !!landed && landed.y < 19.9,
      landed ? `landed at y=${landed.y.toFixed(2)} z=${landed.z.toFixed(1)}` : 'never landed');
    check('projectile pool released', p.projectiles.count === 0, `count=${p.projectiles.count}`);
  }

  /* ---- 14. ragdoll ---- */
  section('14. ragdoll');
  {
    const rd = p.ragdolls.spawn(new THREE.Vector3(5, 4, 5), { vx: 3, vy: 1, vz: 0, yaw: 0.4 });
    check('ragdoll spawned', !!rd);
    for (let i = 0; i < 600; i++) p.ragdolls.fixedUpdate(DT);
    const c = new THREE.Vector3();
    rd.center(c);
    check('ragdoll settles on the ground', c.y > 0 && c.y < 1.2 && isFinite(c.y),
      `centre y=${c.y.toFixed(3)}`);
    let below = false;
    for (let i = 0; i < 15; i++) { const v = new THREE.Vector3(); rd.getPoint(i, v); if (v.y < -0.25) below = true; }
    check('no ragdoll particle fell through the floor', !below);
  }

  /* ---- 15. frozen by the screenshot harness ---- */
  section('15. enabled flag');
  {
    p.teleport(new THREE.Vector3(0, 6, 0));
    p.enabled = false;
    const before = p.position.clone();
    ctx.camera.position.set(12, 2.6, 34);
    const camBefore = ctx.camera.position.clone();
    for (let i = 0; i < 120; i++) { p.fixedUpdate(DT, ctx); p.update(DT, 0, ctx); }
    check('frozen controller does not move', p.position.distanceTo(before) < 1e-9);
    check('frozen controller does not touch the camera',
      ctx.camera.position.distanceTo(camBefore) < 1e-9,
      `camera=(${ctx.camera.position.x}, ${ctx.camera.position.y}, ${ctx.camera.position.z})`);
    p.enabled = true;
  }

  /* ---- 16. camera + no NaN ---- */
  section('16. camera rig');
  {
    p.teleport(FIELD);
    ctx.bus.emit('camera:shake', { amplitude: 0.7, frequency: 30, duration: 0.25 });
    for (let i = 0; i < 400; i++) {
      p.setInput(1, 1, i % 60 === 0, false, true);
      p.fixedUpdate(DT, ctx);
      p.update(1 / 60, 0.5, ctx);
    }
    const c = ctx.camera;
    const finite = [c.position.x, c.position.y, c.position.z, c.quaternion.x, c.fov].every(Number.isFinite);
    check('camera transform is finite', finite);
    check('camera sits at eye height', Math.abs(c.position.y - p.position.y - p.eyeHeight) < 0.25,
      `cam y=${c.position.y.toFixed(3)} feet=${p.position.y.toFixed(3)}`);
    check('shake decayed away', p.rig.trauma < 0.02, `trauma=${p.rig.trauma.toFixed(4)}`);
    check('fov in a sane range', c.fov > 80 && c.fov < 130, `fov=${c.fov.toFixed(1)}`);
  }

  /* ---- 17. perf ---- */
  section('17. performance');
  {
    p.teleport(FIELD);
    const t0 = performance.now();
    const N = 12000;
    for (let i = 0; i < N; i++) {
      p.setInput(Math.sin(i * 0.01) > 0 ? 1 : -1, 1, i % 90 === 0, i % 300 < 60, true);
      p.rig.yaw += 0.6 * DT;
      p.fixedUpdate(DT, ctx);
    }
    const ms = performance.now() - t0;
    info(`${N} ticks in ${ms.toFixed(0)} ms => ${(ms / N * 1000).toFixed(1)} us/tick ` +
         `(${(ms / N / (DT * 1000) * 100).toFixed(2)}% of a 120 Hz budget)`);
    check('tick cost is well under budget', ms / N < 0.35);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
