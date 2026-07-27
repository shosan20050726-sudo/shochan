# Visual Critic Rubric

Used by the review loop. The critic's job is to be **specific and harsh**.
"It looks good" and "it looks bad" are both useless. Every finding must name
the frame, the region, and the fix.

## Production tiers

| Tier | Description |
|------|-------------|
| **S** | Indistinguishable from a shipped AAA title (Apex, Battlefield, Modern Warfare) |
| **A** | Shipped AA / high-end indie. Competent but a trained eye spots it |
| **B** | Good hobby project. Clean but obviously not commercial |
| **C** | Programmer art. Untextured, flat lighting, greybox |
| **D** | Broken. Black frames, z-fighting, missing geometry |

## The tells that give away non-AAA work

Look for these specifically. Each is a common failure and each has a fix.

### Lighting & atmosphere
1. **No aerial perspective** — distant geometry is as saturated and contrasty
   as near geometry. Real distance desaturates toward the sky colour. This is
   the #1 reason a big map reads as small and fake.
2. **Flat ambient** — a constant ambient term instead of an environment map,
   so shadowed sides are uniformly grey and dead.
3. **No contact shadows** — objects appear to float because there is no
   darkening in the crevice where they meet the ground.
4. **Blown highlights / crushed blacks** — bad exposure or double-applied sRGB.
5. **No specular response** — metal that does not reflect anything is the
   loudest possible "this is a tech demo" signal.
6. **Single light direction with no fill** — pure black shadow sides.

### Materials
7. **Uniform surfaces** — a wall that is one flat colour, or a tiling texture
   with a visible repeat every few metres.
8. **Blurry at contact range** — no detail-tiling layer, so walking up to a
   wall reveals mush.
9. **No edge wear** — every corner pristine. Real surfaces are damaged where
   they get touched.
10. **Wrong colour space on normal/roughness maps** — makes materials look
    waxy or plastic.

### Geometry & composition
11. **Perfectly sharp 90° edges everywhere** — no bevel means no specular
    highlight along edges, which reads instantly as untextured boxes.
12. **Uniform object scale / grid placement** — obviously procedural
    scattering with no design intent, no landmarks, no focal point.
13. **Empty middle ground** — foreground and skybox but nothing in between.
14. **No set dressing** — no pipes, vents, cables, debris, signage, decals.

### Frame & post
15. **No lens character** — no vignette, no chromatic aberration, no grain.
    Perfectly clean digital frames read as untextured renders.
16. **Aliasing** — jaggies on every silhouette edge.
17. **No motion cue** — nothing implies the camera is a physical object.

## Required output format

For each frame, the critic returns:

```
FRAME <id>
TIER: <S/A/B/C/D>
WORST PROBLEM: <one sentence, the single highest-leverage fix>
FINDINGS:
  - [tell #N] <what is wrong, where in the frame> -> <specific actionable fix>
```

Then an overall verdict, and a **ranked top-5 fix list** across all frames
ordered by visual impact per unit of work.

## Blind protocol

For the blind pass the critic is shown ONLY the images, with no indication of
how they were made, and asked:

1. What tier of production is this?
2. What engine and roughly what year?
3. Is this a shipped commercial game, or a hobby/student project? What
   specifically gives it away?

An honest "this is a hobby project because X" is the most valuable output the
loop can produce. The critic must not be told the answer beforehand.
