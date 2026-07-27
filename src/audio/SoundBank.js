/**
 * The id -> synth registry. Everything playable in the game is addressable by
 * a string here, which is what makes `play('impact.metal')` and the offline
 * verification harness able to share exactly one code path.
 *
 * Each entry:
 *   build(sc, opts)  assemble the voice into sc.out, return its duration
 *   bus              'sfx' | 'ui'  (ui is never spatialised and never ducked)
 *   spatial          default for whether a PannerNode is used
 *   priority         higher survives voice-stealing
 *   tail/early       reverb send scalars (see AudioGraph)
 */
import { WEAPON_SPECS, weaponClass, buildGunshot, buildDryFire, buildWhizby, buildShell } from './Weapons.js';
import { buildFootstep, buildJump, buildLand, buildSlide, SURFACE_LIST } from './Footsteps.js';
import { buildImpact, buildRicochet, buildShieldHit, IMPACT_SURFACES } from './Impacts.js';
import {
  buildHitmarker, buildKillConfirm, buildUI, buildReload, buildReloadEnd,
  buildWeaponSwitch, buildAbility, buildHeartbeat, buildRingStage, buildRingDamage,
} from './UISfx.js';

export const BANK = Object.create(null);

function def(id, entry) {
  BANK[id] = Object.assign({
    bus: 'sfx', spatial: true, priority: 5, tail: 0.30, early: 0.35,
  }, entry);
  return BANK[id];
}

/* ------------------------------------------------------------------- weapons */
for (const cls of Object.keys(WEAPON_SPECS)) {
  const spec = WEAPON_SPECS[cls];
  def(`shot.${cls}`, {
    build: (sc, opts) => buildGunshot(sc, spec, opts),
    priority: 10, tail: spec.tail, early: spec.early, duck: 1.0,
  });
}
def('shot.dryfire', { build: buildDryFire, priority: 8, tail: 0.15, early: 0.3 });
def('weapon.whizby', { build: buildWhizby, priority: 7, tail: 0.20, early: 0.25 });
def('weapon.shell', { build: buildShell, priority: 2, tail: 0.18, early: 0.4 });
def('weapon.switch', { build: buildWeaponSwitch, priority: 6, spatial: false, tail: 0.10, early: 0.3 });
def('weapon.reload', { build: buildReload, priority: 6, spatial: false, tail: 0.10, early: 0.3 });
def('weapon.reload.end', { build: buildReloadEnd, priority: 6, spatial: false, tail: 0.10, early: 0.3 });

/* ----------------------------------------------------------------- footsteps */
for (const s of SURFACE_LIST) {
  def(`footstep.${s}`, {
    build: (sc, opts) => buildFootstep(sc, { surface: s, ...opts }),
    priority: 3, tail: 0.16, early: 0.42,
  });
}
def('footstep', { build: buildFootstep, priority: 3, tail: 0.16, early: 0.42 });
def('player.jump', { build: buildJump, priority: 4, tail: 0.16, early: 0.40 });
def('player.land', { build: buildLand, priority: 5, tail: 0.22, early: 0.45 });
def('player.slide', { build: buildSlide, priority: 4, tail: 0.20, early: 0.40 });

/* ------------------------------------------------------------------- impacts */
for (const s of IMPACT_SURFACES) {
  def(`impact.${s}`, {
    build: (sc, opts) => buildImpact(sc, { surface: s, ...opts }),
    priority: 6, tail: 0.26, early: 0.40,
  });
}
def('impact', { build: buildImpact, priority: 6, tail: 0.26, early: 0.40 });
def('impact.ricochet', { build: buildRicochet, priority: 5, tail: 0.34, early: 0.42 });
def('impact.shield', { build: (sc, o) => buildShieldHit(sc, o), priority: 6, tail: 0.24, early: 0.38 });
def('impact.shieldbreak', {
  build: (sc, o) => buildShieldHit(sc, { ...o, broke: true }), priority: 8, tail: 0.30, early: 0.40,
});

/* ------------------------------------------------------------------------ ui */
const UI = { bus: 'ui', spatial: false, tail: 0.0, early: 0.06 };
def('hit.body', { build: (sc, o) => buildHitmarker(sc, o), priority: 9, ...UI });
def('hit.head', { build: (sc, o) => buildHitmarker(sc, { ...o, headshot: true }), priority: 9, ...UI });
def('hit.shield', { build: (sc, o) => buildHitmarker(sc, { ...o, shield: true }), priority: 9, ...UI });
def('hit.kill', { build: (sc, o) => buildHitmarker(sc, { ...o, kill: true }), priority: 10, ...UI });
def('ui.killconfirm', { build: buildKillConfirm, priority: 10, ...UI });
for (const k of ['click', 'hover', 'confirm', 'error', 'select', 'pickup']) {
  def(`ui.${k}`, { build: (sc, o) => buildUI(sc, { ...o, kind: k }), priority: 7, ...UI });
}
def('ui.heartbeat', { build: buildHeartbeat, priority: 8, ...UI, early: 0.0 });

/* ---------------------------------------------------------------- abilities */
def('ability.tactical', {
  build: (sc, o) => buildAbility(sc, { ...o, slot: 'tactical' }), priority: 8, tail: 0.30, early: 0.40,
});
def('ability.ultimate', {
  build: (sc, o) => buildAbility(sc, { ...o, slot: 'ultimate' }), priority: 10, tail: 0.42, early: 0.45,
});

/* --------------------------------------------------------------------- ring */
def('ring.stage', { build: buildRingStage, priority: 10, spatial: false, bus: 'ui', tail: 0.30, early: 0.20 });
def('ring.damage', { build: buildRingDamage, priority: 6, spatial: false, bus: 'ui', tail: 0.12, early: 0.20 });

/** Resolve an id, tolerating unknown surfaces/weapons. */
export function resolve(id) {
  if (BANK[id]) return BANK[id];
  const s = String(id || '');
  if (s.startsWith('shot.')) return BANK[`shot.${weaponClass(s.slice(5))}`] || BANK['shot.rifle'];
  if (s.startsWith('footstep')) return BANK['footstep.concrete'];
  if (s.startsWith('impact')) return BANK['impact.concrete'];
  return null;
}

export const ALL_IDS = () => Object.keys(BANK);

export default BANK;
