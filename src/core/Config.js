/**
 * Single source of truth for tuning. Every module reads from here so the
 * feel of the game can be retuned without hunting through systems.
 * Units: metres, seconds, radians. 1 unit = 1 metre.
 */
export const CFG = {
  time: {
    fixedStep: 1 / 120,   // physics tick
    maxSubSteps: 8,       // spiral-of-death guard
  },

  // Apex-style momentum movement. These numbers are the soul of the game.
  move: {
    walkSpeed: 4.6,
    sprintSpeed: 6.9,
    crouchSpeed: 2.4,
    accelGround: 68,
    accelAir: 12,          // low, but air-strafe adds speed via steering
    airStrafeGain: 1.9,    // bhop/strafe acceleration multiplier
    friction: 7.2,
    stopSpeed: 1.6,
    gravity: 21.0,
    jumpVelocity: 7.4,
    coyoteTime: 0.11,
    jumpBuffer: 0.14,
    maxSpeedCap: 26.0,

    // Slide: the defining Apex mechanic. Downhill accelerates, flat decays.
    slide: {
      minEntrySpeed: 5.2,
      boost: 3.1,          // impulse on entry when sprinting
      frictionFlat: 2.35,
      frictionDownhill: 0.35,
      slopeAccel: 15.5,    // gravity projected along slope
      minExitSpeed: 2.6,
      maxDuration: 2.2,
      heightCrouch: 0.95,
      cooldown: 0.28,
    },

    // Wall-bounce / tap-strafe style redirection.
    wallBounce: {
      enabled: true,
      maxWallAngle: 0.62,   // dot threshold for a "wall"
      speedRetain: 0.92,
      outwardImpulse: 4.6,
      upImpulse: 3.4,
      window: 0.22,         // seconds after wall contact
    },

    mantle: {
      maxHeight: 2.35,
      minHeight: 0.55,
      reach: 0.85,
      duration: 0.42,
      minClearance: 0.55,
    },

    player: {
      radius: 0.42,
      height: 1.82,
      eyeOffset: 0.14,      // below top of capsule
      stepHeight: 0.42,
      maxSlopeAngle: 0.78,  // ~45deg walkable
    },
  },

  camera: {
    fov: 96,
    adsFovScale: 0.72,
    sprintFovBoost: 6,
    slideFovBoost: 9,
    viewmodelFov: 62,
    near: 0.02,
    far: 2400,
    sensitivity: 0.0021,
    adsSensScale: 0.65,
    maxPitch: Math.PI / 2 - 0.015,
    // Procedural camera life: without these the game reads as a tech demo.
    bobAmount: 0.028,
    bobSpeed: 11.2,
    landDip: 0.16,
    slideRoll: 0.085,
    strafeRoll: 0.032,
    shakeDecay: 8.5,
  },

  combat: {
    healthMax: 100,
    shieldTiers: [50, 75, 100, 125], // white/blue/purple/red evo
    headshotMul: 2.0,
    legshotMul: 0.8,
    reviveTime: 6.0,
    downedHealth: 60,
  },

  ring: {
    // Match flow: closing circles that force engagement.
    stages: [
      { waitTime: 45, closeTime: 90, radius: 300, dps: 2 },
      { waitTime: 40, closeTime: 75, radius: 180, dps: 4 },
      { waitTime: 35, closeTime: 60, radius: 100, dps: 8 },
      { waitTime: 30, closeTime: 50, radius: 48, dps: 15 },
      { waitTime: 25, closeTime: 40, radius: 16, dps: 25 },
      { waitTime: 20, closeTime: 35, radius: 3, dps: 40 },
    ],
    height: 260,
  },

  gfx: {
    shadowMapSize: 2048,
    cascadeCount: 3,
    cascadeSplits: [0.06, 0.22, 1.0],
    shadowDistance: 220,
    exposure: 1.06,
    bloomStrength: 0.42,
    bloomRadius: 0.55,
    bloomThreshold: 0.92,
    ssaoRadius: 0.55,
    ssaoIntensity: 0.9,
    motionBlurStrength: 0.42,
    vignette: 0.32,
    chromaticAberration: 0.0016,
    filmGrain: 0.022,
    anisotropy: 8,
  },

  audio: {
    masterGain: 0.65,
    sfxGain: 0.9,
    musicGain: 0.35,
    rolloff: 1.6,
    refDistance: 6,
    maxDistance: 420,
  },

  world: {
    size: 640,            // playfield extent (metres)
    seed: 0xA9EC,
  },
};

export default CFG;
