# APEX PROTOCOL

A browser first-person shooter built on WebGL2 / three.js. Momentum movement,
recoil-pattern gunplay, squad AI, legend abilities, and a closing ring.

**Everything is generated in code.** There are no texture files, no audio
files, no models, and no network requests at runtime. Textures are rendered on
the GPU at boot, weapons and characters are assembled from procedural
primitives, and every sound is synthesised with the Web Audio API.

```bash
npm install
npm run dev      # play at the printed URL
npm run build    # production bundle into dist/
```

Click to lock the pointer. **WASD** move · **Shift** sprint · **Ctrl** slide ·
**Space** jump · **R** reload · **1/2** weapons · **Q** tactical · **Z**
ultimate · **Esc** settings.

## Layout

```
src/core/       engine, fixed-timestep loop, input, config, seeded RNG
src/gfx/        sky, cascaded shadows, post-processing chain
src/materials/  procedural PBR texture forge and material library
src/world/      terrain, seven points of interest, collision contract
src/physics/    capsule character controller, triangle BVH, projectiles
src/weapons/    weapon definitions, procedural viewmodel, arms, recoil
src/ai/         bot bodies, perception, navigation, squad combat
src/legends/    abilities
src/vfx/        GPU particles, decals, ring wall, atmosphere
src/audio/      fully synthesised weapon, impact and ambience audio
src/ui/         HUD
src/game/       match flow and the closing ring
tools/          screenshot and diagnostic harnesses
```

`CONTRACTS.md` documents the interfaces between systems. Tuning constants live
in `src/core/Config.js`; systems read from it rather than hardcoding values.

## Notes on a few decisions

**Two-layer camera rendering.** The world renders at 96° FOV and the viewmodel
at 62° in a second pass with depth cleared, so the weapon neither warps at the
edges nor clips through walls.

**Deterministic recoil.** Each weapon carries a pattern of kick vectors indexed
by shot number, so a spray is learnable and can be counter-pulled. Only a small
jitter is random.

**Distance is modelled in audio, not just attenuated.** An air-absorption
lowpass, speed-of-sound delay, and a reverb send that rises as the dry signal
falls. Measured, a rifle's spectral centroid falls from 3098 Hz at 5 m to
172 Hz at 350 m; in a canyon the tail carries more energy than the arrival.

**The ring never jumps somewhere unreachable.** Each next circle is sampled
inside the current one, area-uniformly so it does not cluster in the middle.

**Arms parent to the weapon, not the camera**, so they inherit its sway, bob,
recoil and reload animation instead of needing a second rig kept in sync. Hand
positions interpolate between the viewmodel's own muzzle and ejection-port
anchors, so they land correctly on every weapon in the roster without
per-weapon tuning.

## Diagnostics

Rendering here runs on CPU-side SwiftShader, so frames take minutes and the
reported FPS is not a performance signal. These exist because guessing at
rendering bugs from source proved much slower than asking the runtime:

```bash
node tools/review.mjs <label>   # six framed screenshots -> shots/review-<label>/
node tools/errprobe.mjs         # asserts the frame loop is live and lists errors
node tools/diag.mjs <variant>   # same pose under scene mutations, to bisect
node tools/whatishit.mjs        # names the mesh filling a screen region
node tools/uniprobe.mjs         # names a material that throws on uniform upload
node tools/geomcheck.mjs        # finds non-finite vertices
node tools/vmprobe.mjs          # viewmodel anchor points and bounding boxes
```

Two traps these were built to catch, both of which caused real misdiagnoses:

- A frozen image does **not** mean the loop died, and a live loop does **not**
  mean there are no errors. The engine catches per-frame exceptions and keeps
  running, so a throw inside the world render aborts the draw every frame while
  the frame counter climbs.
- Non-finite vertices rasterise as huge triangles but raycasts against them
  fail, producing the contradictory pair "clearly drawn here" and "a ray through
  that pixel hits nothing".

## Known issues

- A large straight-edged discontinuity is visible across wide shots. Shadows,
  VFX, post compositing, non-finite geometry and ordinary scene geometry have
  each been ruled out by measurement; the evidence points at the sky and
  atmosphere shaders. Unresolved.

- **No ambient occlusion reaches the frame**, so nothing darkens at a concave
  junction or where an object meets the ground.

  What is established, in increasing order of strength. Tuning is not the
  problem: `node tools/diag.mjs l-ssaomax` pushes intensity and radius far
  past any sane value and the frame is unchanged. The tint is not the problem
  either: `n-aoblack` forces the AO colour to pure black, which would turn
  every occluded pixel black, and nothing darkens.

  The decisive one: temporarily rewriting the SSAO shader to output raw depth
  instead of occlusion — arbitrary, obviously different content in the AO
  buffer — *also* changes nothing. So the AO result is not reaching the
  composite at all, and the fault is in the binding or the pass wiring rather
  than in the SSAO shader's occlusion maths.

  Note that a reading of the code alone suggested the opposite, and it was
  wrong: `tAO` is bound to the AO target, `USE_AO` is present in the aerial
  pass's defines, that pass always runs, and every uniform the SSAO shader
  declares is supplied and kept updated. All of that is true and none of it
  saves the result. Start from the buffer-content experiment, not the source.
- The first-person hands are placed correctly but still read as dark masses
  rather than gloved hands.
- Middle-ground set dressing between points of interest is sparse: no roads
  connecting them, no vehicles, no rock scatter.
- No temporal AA, so thin geometry such as masts and railings aliases.

Weapon and character names are original. Nothing here uses another title's
trademarks.
