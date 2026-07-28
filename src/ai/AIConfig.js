/**
 * Every AI tuning number, read out of CFG defensively so the lead can fold
 * an `ai:` block into src/core/Config.js later without this module changing.
 *
 * Nothing else in src/ai/ is allowed to hardcode a tunable.
 */
import CFG from '../core/Config.js';

const A = CFG.ai ?? {};
const V = A.vision ?? {};
const H = A.hearing ?? {};
const C = A.combat ?? {};
const M = A.move ?? {};
const N = A.nav ?? {};
const S = A.squad ?? {};
const B = A.budget ?? {};

export const AI = {
  seed: A.seed ?? 0xB07C,
  /** Squads of three, Apex-style. */
  squadSize: A.squadSize ?? 3,
  squads: A.squads ?? 3,
  maxBots: A.maxBots ?? 12,
  /** 0 = docile, 1 = frightening. Scales aim, reaction and aggression. */
  difficulty: A.difficulty ?? 0.55,

  /** Distance band a fresh squad is allowed to drop in at, from the player. */
  spawnMin: A.spawnMin ?? 55,
  spawnMax: A.spawnMax ?? 220,
  respawnDelay: A.respawnDelay ?? 22,
  /** Squads further away than this stop simulating in detail. */
  cullDistance: A.cullDistance ?? 320,

  health: A.health ?? CFG.combat?.healthMax ?? 100,
  shield: A.shield ?? (CFG.combat?.shieldTiers?.[1] ?? 75),
  downedHealth: A.downedHealth ?? CFG.combat?.downedHealth ?? 60,
  reviveTime: A.reviveTime ?? CFG.combat?.reviveTime ?? 6.0,
  /** Bleedout while downed and unattended. */
  bleedTime: A.bleedTime ?? 34,

  vision: {
    fov: V.fov ?? 2.10,               // radians, full cone (~120 deg)
    peripheralFov: V.peripheralFov ?? 2.95,
    range: V.range ?? 165,
    peripheralRange: V.peripheralRange ?? 26,
    /** Beyond this fraction of range, spotting slows down sharply. */
    falloffStart: V.falloffStart ?? 0.35,
    gain: V.gain ?? 2.9,              // awareness per second at ideal conditions
    decay: V.decay ?? 0.55,
    /** Awareness at which the contact is confirmed and shared with the squad. */
    confirm: V.confirm ?? 1.0,
    losInterval: V.losInterval ?? 0.22,
    /** A sprinting, unsuppressed target is much easier to pick up. */
    motionBonus: V.motionBonus ?? 0.9,
    crouchPenalty: V.crouchPenalty ?? 0.55,
    memory: V.memory ?? 9.0,          // seconds a lost contact is still chased
  },

  hearing: {
    shotRadius: H.shotRadius ?? 130,
    footstepRadius: H.footstepRadius ?? 26,
    impactRadius: H.impactRadius ?? 34,
    /** Positional error on a heard event, metres at max range. */
    error: H.error ?? 7.0,
    /** Occlusion just shortens the radius; no ray is cast for sound. */
    occlusion: H.occlusion ?? 0.55,
  },

  reaction: {
    /** Seconds between "I see you" and "I am shooting at you". */
    min: A.reaction?.min ?? 0.16,
    max: A.reaction?.max ?? 0.62,
    /** Extra latency when the contact came from sound rather than sight. */
    audio: A.reaction?.audio ?? 0.35,
    /** Turn rate while acquiring vs. tracking (rad/s). */
    turnAcquire: A.reaction?.turnAcquire ?? 5.2,
    turnTrack: A.reaction?.turnTrack ?? 2.4,
  },

  combat: {
    /** Rounds per burst, before discipline modifiers. */
    burstMin: C.burstMin ?? 3,
    burstMax: C.burstMax ?? 7,
    burstGapMin: C.burstGapMin ?? 0.24,
    burstGapMax: C.burstGapMax ?? 0.85,
    /** Cone the first shot of an engagement lands in, radians. */
    aimErrorBase: C.aimErrorBase ?? 0.075,
    /**
     * Floor on the aim cone. Anything much under ~0.8 deg and a converged bot
     * simply cannot miss a torso inside 40 m, which is an aimbot with extra
     * steps. This is the single most important number in the file.
     */
    aimErrorMin: C.aimErrorMin ?? 0.014,
    /** Seconds of continuous tracking before error reaches its floor. */
    converge: C.converge ?? 1.5,
    /** Extra error per m/s of target lateral speed. */
    motionError: C.motionError ?? 0.0075,
    /** How much of the correct lead is actually applied. */
    lead: C.lead ?? 0.72,
    /** Hitscan flight is instant; this is the human "where will they be" lag. */
    leadLatency: C.leadLatency ?? 0.08,
    /** Suppressing fire lands near, not on, the target. */
    suppressError: C.suppressError ?? 0.055,
    suppressRange: C.suppressRange ?? 90,
    idealRange: C.idealRange ?? 26,
    minRange: C.minRange ?? 6,
    maxEngage: C.maxEngage ?? 140,
    reloadAt: C.reloadAt ?? 0.18,     // fraction of magazine left
    /** Bot damage is scaled down: they have perfect information, players do not. */
    damageScale: C.damageScale ?? 0.55,
    /** Seconds a bot stays "suppressed" (heads down) after being shot near. */
    suppressedTime: C.suppressedTime ?? 1.15,
  },

  move: {
    walk: M.walk ?? (CFG.move?.walkSpeed ?? 4.6) * 0.62,
    run: M.run ?? (CFG.move?.sprintSpeed ?? 6.9) * 0.88,
    strafe: M.strafe ?? (CFG.move?.walkSpeed ?? 4.6) * 0.72,
    crouch: M.crouch ?? (CFG.move?.crouchSpeed ?? 2.4),
    crawl: M.crawl ?? 1.15,
    accel: M.accel ?? 26,
    decel: M.decel ?? 34,
    turnRate: M.turnRate ?? 7.5,
    gravity: M.gravity ?? (CFG.move?.gravity ?? 21),
    radius: M.radius ?? (CFG.move?.player?.radius ?? 0.42) * 0.92,
    height: M.height ?? (CFG.move?.player?.height ?? 1.82),
    // A crouched *body*, not the game's slide capsule: 0.95 m is a tuck, and a
    // character modelled that short reads as a gnome.
    crouchHeight: M.crouchHeight ?? Math.max(1.28, CFG.move?.slide?.heightCrouch ?? 0.95),
    stepHeight: M.stepHeight ?? (CFG.move?.player?.stepHeight ?? 0.42),
    /** Local avoidance: how hard squadmates push each other apart. */
    separation: M.separation ?? 2.4,
    separationRadius: M.separationRadius ?? 1.5,
    /** Random lateral offset on the shared path so they do not conga-line. */
    laneSpread: M.laneSpread ?? 1.35,
    arrive: M.arrive ?? 1.1,
  },

  nav: {
    repath: N.repath ?? 1.35,
    /** Repath early if the goal has moved this far since the path was built. */
    goalDrift: N.goalDrift ?? 4.5,
    maxNodes: N.maxNodes ?? 5200,
    /** Grid cells of clearance preferred around a path. */
    clearanceWeight: N.clearanceWeight ?? 1.6,
    /** Fallback straight-line steering when A* fails. */
    stuckTime: N.stuckTime ?? 1.6,
  },

  squad: {
    /** Radius the squad tries to hold around its anchor. */
    spacing: S.spacing ?? 5.5,
    coverSamples: S.coverSamples ?? 24,
    coverRadius: S.coverRadius ?? 13,
    /** Squad strength below which they break off and retreat. */
    retreatAt: S.retreatAt ?? 0.34,
    /** Squad strength above which they push a knocked enemy. */
    pushAt: S.pushAt ?? 0.62,
    flankAngle: S.flankAngle ?? 1.15,
    /** Seconds a shared contact stays actionable without an update. */
    contactMemory: S.contactMemory ?? 11,
    reviveRange: S.reviveRange ?? 1.6,
  },

  budget: {
    /** Hard caps per rendered frame — the whole point of the scheduler. */
    losPerFrame: B.losPerFrame ?? 4,
    pathsPerFrame: B.pathsPerFrame ?? 1,
    coverPerFrame: B.coverPerFrame ?? 1,
    groundProbesPerFrame: B.groundProbesPerFrame ?? 6,
    /** Bots animated at full rate; beyond this they update pose at 15 Hz. */
    animNear: B.animNear ?? 55,
  },
};

export default AI;
