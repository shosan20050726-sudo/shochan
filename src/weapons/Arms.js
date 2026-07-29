import * as THREE from 'three';
import { palette, boxGeo, cylGeo, sphereGeo } from './Parts.js';

/**
 * First-person arms.
 *
 * Built procedurally and parented to the viewmodel rig, so they inherit the
 * gun's sway, bob, recoil and reload animation for free rather than needing a
 * second animation system kept in sync with the first.
 *
 * Hand placement is derived from the weapon definition rather than hardcoded:
 * the trigger hand sits behind and below the receiver at the grip, the support
 * hand forward on the handguard, scaled by the weapon's own barrel and
 * receiver lengths. A shotgun's support hand therefore lands on its pump and a
 * marksman rifle's much further forward, without per-weapon tuning.
 */

const GLOVE = 0x2a2e34;
const SLEEVE = 0x3f4650;
const SKIN = 0x8a5f43;

/**
 * One arm, built at the origin with the hand AT the origin.
 *
 * Model space here runs forward along -Z, so the arm extends backwards toward
 * the player along +Z and the fingers sit slightly forward of the palm. The
 * group can then simply be positioned at whatever point on the weapon the hand
 * is meant to hold.
 */
function buildArm(mats, side, opts = {}) {
  const g = new THREE.Group();
  const s = side === 'left' ? -1 : 1;
  const fore = opts.forearm ?? 0.26;
  const r = opts.radius ?? 0.034;

  // Forearm runs back from the wrist, tapering toward it, slightly flattened
  // so it does not read as a pipe under a raking key light.
  const forearm = new THREE.Mesh(cylGeo(r * 1.12, r * 0.86, fore, 10), mats.sleeve);
  forearm.rotation.x = Math.PI / 2;
  forearm.position.set(0, 0, fore * 0.5 + 0.03);
  forearm.scale.set(1, 0.86, 1);
  g.add(forearm);

  // Cuff: a proud ring where glove meets sleeve catches a highlight and hides
  // the seam between two cylinders.
  const cuff = new THREE.Mesh(cylGeo(r * 1.2, r * 1.16, 0.026, 10), mats.glove);
  cuff.rotation.x = Math.PI / 2;
  cuff.position.set(0, 0, 0.030);
  g.add(cuff);

  const wrist = new THREE.Mesh(sphereGeo(r * 0.9, 8), mats.skin);
  wrist.position.set(0, 0, 0.021);
  wrist.scale.set(1, 0.82, 0.5);
  g.add(wrist);

  // Palm sits on the origin: the grip point.
  const palm = new THREE.Mesh(boxGeo(r * 1.85, r * 2.4, r * 1.3, 0.010), mats.glove);
  g.add(palm);

  // Fingers curl forward and under, around whatever is being held. Four stubs
  // plus a thumb reads as a grip at viewmodel FOV; individual joints do not
  // resolve and are not worth the triangles.
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(cylGeo(r * 0.29, r * 0.27, r * 1.45, 6), mats.glove);
    f.rotation.set(Math.PI / 2 - 0.85, 0, 0);
    f.position.set((i - 1.5) * r * 0.5, -r * 0.9, -0.026);
    g.add(f);
  }
  const thumb = new THREE.Mesh(cylGeo(r * 0.33, r * 0.31, r * 1.3, 6), mats.glove);
  thumb.rotation.set(Math.PI / 2 - 0.3, 0, s * 0.75);
  thumb.position.set(s * r * 0.9, r * 0.2, -0.018);
  g.add(thumb);

  for (const m of g.children) { m.frustumCulled = false; m.castShadow = false; }
  return g;
}

/**
 * @param {object} vm   result of buildViewmodel(def)
 * @param {object} def  weapon definition
 * @returns {{group:THREE.Group, left:THREE.Group, right:THREE.Group}}
 */
export function buildArms(vm, def) {
  const p = palette(def.model?.tint || {});
  const mats = {
    glove: p.grip,
    sleeve: p.poly,
    skin: p.wood,          // warm, rough — closest match in the shared palette
  };

  const group = new THREE.Group();
  group.name = 'vm-arms';

  // Anchor to the geometry that actually exists rather than the definition's
  // nominal dimensions: `eject` sits on the receiver and `muzzle` at the end
  // of the barrel, both already in model space. Interpolating between them
  // puts the support hand on the handguard of every frame in the roster
  // without per-weapon tuning, and correctly further forward on a long one.
  const eject = vm.eject ?? new THREE.Vector3(0.028, 0.045, -0.02);
  const muzzle = vm.muzzle ?? new THREE.Vector3(0, 0.048, -0.52);
  const bore = (eject.y + muzzle.y) * 0.5;

  // Trigger hand: behind the ejection port, hanging below the bore on the grip.
  const right = buildArm(mats, 'right', { forearm: 0.30 });
  right.position.set(0.012, bore - 0.098, eject.z + 0.085);
  right.rotation.set(-0.30, -0.10, 0.08);
  group.add(right);

  // Support hand: partway down the barrel, under the handguard.
  const left = buildArm(mats, 'left', { forearm: 0.28 });
  left.position.set(-0.030, bore - 0.072, eject.z + (muzzle.z - eject.z) * 0.52);
  left.rotation.set(-0.22, 0.18, -0.45);
  group.add(left);

  group.traverse((o) => { o.frustumCulled = false; });
  return { group, left, right };
}

export default buildArms;
