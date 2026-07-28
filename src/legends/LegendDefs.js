import * as THREE from 'three';
import { EV } from '../core/EventBus.js';

/**
 * Legend definitions.
 *
 * Each ability is a data entry with an `onUse(api)` hook. `api` gives the
 * origin and aim direction, an `aimPoint()` raycast helper, the player and
 * world systems, and `spawn(effect)` for anything that needs to live for a
 * while — the system ticks `update`, then calls `dispose` when `life` runs out.
 *
 * The abilities deliberately cover the three shapes that matter in this genre:
 * area denial, repositioning, and team utility. Everything is procedural, so
 * none of it needs an asset.
 */

const _v = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/* ------------------------------------------------------------- helpers -- */

/** A soft emissive dome that grows, holds, then fades. Used by several abilities. */
function domeEffect({ position, radius, color, life = 18, opacity = 0.3 }) {
  const geo = new THREE.SphereGeometry(1, 24, 16);
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0, side: THREE.DoubleSide,
    depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(position);
  mesh.scale.setScalar(0.1);
  mesh.renderOrder = 5;
  mesh.frustumCulled = false;

  const total = life;
  return {
    life,
    mesh,
    added: false,
    update(dt, ctx) {
      if (!this.added) { ctx.scene.add(mesh); this.added = true; }
      const t = 1 - this.life / total;
      // Grow fast, hold, then collapse — reads as deployed, not spawned.
      const grow = Math.min(1, t / 0.12);
      const fade = this.life < 1.5 ? this.life / 1.5 : 1;
      mesh.scale.setScalar(radius * (0.25 + 0.75 * grow));
      mat.opacity = opacity * fade * grow;
    },
    dispose(ctx) {
      ctx?.scene.remove(mesh);
      geo.dispose(); mat.dispose();
    },
  };
}

/** Vertical smoke column that blocks sight for a while. */
function smokeColumn(api, point, radius, life) {
  const bus = api.bus;
  // Feed the existing particle system rather than inventing a new one.
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2;
    _v.set(point.x + Math.cos(a) * radius * 0.6, point.y + 0.4, point.z + Math.sin(a) * radius * 0.6);
    bus.emit(EV.IMPACT, {
      point: _v.clone(),
      normal: UP.clone(),
      surface: 'sand',
      scale: 2.4,
    });
  }
  api.spawn(domeEffect({
    position: point, radius, color: 0x9aa6b4, life, opacity: 0.22,
  }));
}

/* -------------------------------------------------------------- legends -- */

export const LEGENDS = {
  /** Area denial. Deploy cover where there is none. */
  bulwark: {
    id: 'bulwark',
    name: 'BULWARK',
    passive: 'Incoming damage while shielded is reduced slightly.',
    ultPassiveRate: 0.0042,
    ultDamageGain: 0.0011,
    tactical: {
      name: 'SMOKE LINE',
      charges: 2,
      cooldown: 22,
      onUse(api) {
        const p = api.aimPoint(26).clone();
        smokeColumn(api, p, 4.5, 14);
        api.bus.emit(EV.CAMERA_SHAKE, { amplitude: 0.05, frequency: 18, duration: 0.2 });
      },
    },
    ultimate: {
      name: 'BASTION DOME',
      onUse(api) {
        const p = api.aimPoint(14).clone();
        api.spawn(domeEffect({ position: p, radius: 7.5, color: 0x49d8ff, life: 20, opacity: 0.26 }));
        api.bus.emit(EV.CAMERA_SHAKE, { amplitude: 0.16, frequency: 26, duration: 0.4 });
      },
    },
  },

  /** Repositioning. Trade safety for tempo. */
  vector: {
    id: 'vector',
    name: 'VECTOR',
    passive: 'Slides carry momentum for longer.',
    ultPassiveRate: 0.0050,
    ultDamageGain: 0.0014,
    tactical: {
      name: 'BLINK STEP',
      charges: 2,
      cooldown: 16,
      onUse(api) {
        const player = api.player;
        if (!player?.addImpulse) return;
        // A directed dash rather than a teleport: it has to be readable by
        // whoever is shooting at you.
        _v.copy(api.direction);
        _v.y = Math.max(_v.y, 0.12);
        _v.normalize().multiplyScalar(11.5);
        player.addImpulse(_v);
        api.bus.emit(EV.CAMERA_SHAKE, { amplitude: 0.1, frequency: 30, duration: 0.18 });
      },
    },
    ultimate: {
      name: 'SLIPSTREAM',
      onUse(api) {
        const p = api.aimPoint(30).clone();
        api.spawn(domeEffect({ position: p, radius: 5.5, color: 0xb46bff, life: 16, opacity: 0.22 }));
        api.bus.emit(EV.CAMERA_SHAKE, { amplitude: 0.2, frequency: 22, duration: 0.5 });
      },
    },
  },

  /** Team utility. Information instead of damage. */
  augur: {
    id: 'augur',
    name: 'AUGUR',
    passive: 'Nearby gunfire is marked on the minimap for longer.',
    ultPassiveRate: 0.0038,
    ultDamageGain: 0.0010,
    tactical: {
      name: 'PULSE SCAN',
      charges: 1,
      cooldown: 18,
      onUse(api) {
        const p = api.origin.clone();
        api.spawn(domeEffect({ position: p, radius: 26, color: 0x6fe3c0, life: 3.5, opacity: 0.12 }));
        // The AI system decides what being scanned means; this just announces it.
        api.bus.emit('ability:scan', { position: p, radius: 26, duration: 6 });
      },
    },
    ultimate: {
      name: 'BEACON',
      onUse(api) {
        const p = api.aimPoint(40).clone();
        api.spawn(domeEffect({ position: p, radius: 12, color: 0xffc46b, life: 22, opacity: 0.18 }));
        api.bus.emit('ability:scan', { position: p, radius: 60, duration: 20 });
      },
    },
  },
};

export const DEFAULT_LEGEND = 'bulwark';
export const LEGEND_IDS = Object.keys(LEGENDS);
export default LEGENDS;
