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

/** One arm: upper sleeve, forearm, hand, and a suggestion of fingers. */
function buildArm(mats, side, opts = {}) {
  const g = new THREE.Group();
  const s = side === 'left' ? -1 : 1;
  const fore = opts.forearm ?? 0.26;
  const r = opts.radius ?? 0.038;

  // Forearm, tapering toward the wrist. Slightly flattened so it does not
  // read as a pipe under a raking key light.
  const forearm = new THREE.Mesh(cylGeo(r * 0.86, r * 1.12, fore, 10), mats.sleeve);
  forearm.rotation.x = Math.PI / 2;
  forearm.position.set(0, 0, -fore * 0.5);
  forearm.scale.set(1, 0.86, 1);
  g.add(forearm);

  // Cuff: a small proud ring where glove meets sleeve catches a highlight and
  // hides the seam between two cylinders.
  const cuff = new THREE.Mesh(cylGeo(r * 1.18, r * 1.14, 0.028, 10), mats.glove);
  cuff.rotation.x = Math.PI / 2;
  cuff.position.set(0, 0, -0.012);
  g.add(cuff);

  // Palm.
  const palm = new THREE.Mesh(boxGeo(r * 1.9, r * 2.5, r * 1.35, 0.012), mats.glove);
  palm.position.set(0, 0, 0.045);
  g.add(palm);

  // Fingers, curled around whatever the hand is holding. Four stubs plus a
  // thumb reads as a grip at viewmodel distance; individual joints do not
  // survive the FOV and are not worth the triangles.
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(cylGeo(r * 0.30, r * 0.28, r * 1.5, 6), mats.glove);
    f.rotation.set(Math.PI / 2 - 0.9, 0, 0);
    f.position.set((i - 1.5) * r * 0.52, -r * 0.95, 0.075);
    g.add(f);
  }
  const thumb = new THREE.Mesh(cylGeo(r * 0.34, r * 0.32, r * 1.35, 6), mats.glove);
  thumb.rotation.set(Math.PI / 2 - 0.35, 0, s * 0.7);
  thumb.position.set(s * r * 0.95, r * 0.15, 0.062);
  g.add(thumb);

  // A sliver of wrist between cuff and glove sells that this is a person.
  const wrist = new THREE.Mesh(sphereGeo(r * 0.92, 8), mats.skin);
  wrist.position.set(0, 0, 0.012);
  wrist.scale.set(1, 0.8, 0.6);
  g.add(wrist);

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

  const barrel = def.model?.barrel ?? 0.2;
  const receiver = def.model?.receiver ?? 0.28;

  // Trigger hand: behind the receiver, below the bore, angled into the grip.
  const right = buildArm(mats, 'right', { forearm: 0.30 });
  right.position.set(0.028, -0.062, receiver * 0.34);
  right.rotation.set(-0.42, -0.12, 0.10);
  group.add(right);

  // Support hand: forward on the handguard. Scales with the actual barrel
  // length, so it lands on the right part of every frame in the roster.
  const left = buildArm(mats, 'left', { forearm: 0.28 });
  left.position.set(-0.052, -0.055, -(barrel * 0.62 + 0.05));
  left.rotation.set(-0.30, 0.22, -0.55);
  group.add(left);

  group.traverse((o) => { o.frustumCulled = false; });
  return { group, left, right };
}

export default buildArms;
