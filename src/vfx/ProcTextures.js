import * as THREE from 'three';
import { makeRNG, makeNoise2D, fbm2D } from '../core/Rand.js';

/**
 * Every sprite the VFX system draws is generated here at init — canvas
 * gradients for the hot/soft shapes, seeded fbm for the organic ones. No
 * files, no network, and the whole set is deterministic given a seed.
 *
 * Atlases are laid out column-major-by-row (frame = row * cols + col) and
 * every tile fades to alpha 0 well before its border so mipmapping cannot
 * bleed one frame into its neighbour.
 */

const S01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const CLAMP = (v, a, b) => (v < a ? a : v > b ? b : v);

function mkCanvas(w, h) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function toTexture(canvas, { srgb = true, mips = true } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.generateMipmaps = mips;
  t.anisotropy = 1;
  t.needsUpdate = true;
  return t;
}

/* --------------------------------------------------------------- glow ---- */

/** Soft radial with a hot core — sparks, embers, muzzle bloom, dust motes. */
function glowTexture(size = 128) {
  const cv = mkCanvas(size, size);
  const g = cv.getContext('2d');
  const c = size * 0.5;
  const grad = g.createRadialGradient(c, c, 0, c, c, c);
  // Two-lobe falloff: a tight specular core over a wide, very soft halo.
  const stops = [
    [0.00, 1.00], [0.045, 0.99], [0.09, 0.86], [0.15, 0.62],
    [0.24, 0.36], [0.34, 0.20], [0.47, 0.098], [0.62, 0.042],
    [0.78, 0.014], [0.90, 0.004], [1.00, 0.0],
  ];
  for (const [s, a] of stops) grad.addColorStop(s, `rgba(255,255,255,${a})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return cv;
}

/* ------------------------------------------------------------- streak ---- */

/** Horizontal capsule streak: white-hot core inside a warm dim halo. */
function streakTexture(w = 256, h = 64) {
  const cv = mkCanvas(w, h);
  const g = cv.getContext('2d');
  const img = g.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const v = ((y + 0.5) / h) * 2 - 1;
    for (let x = 0; x < w; x++) {
      const u = ((x + 0.5) / w) * 2 - 1;
      // distance to a horizontal segment, normalised so the caps are round
      const du = Math.max(Math.abs(u) - 0.60, 0) / 0.40;
      const dist = Math.sqrt(du * du + v * v);
      const f = Math.max(1 - dist, 0);
      const core = Math.pow(f, 7.5);
      const halo = Math.pow(f, 1.9) * 0.34;
      const a = CLAMP(core + halo, 0, 1);
      // hot centre is white, the halo keeps a warm cast
      const warm = 1 - core;
      const i = (y * w + x) * 4;
      d[i] = 255;
      d[i + 1] = Math.round(255 * (1 - warm * 0.30));
      d[i + 2] = Math.round(255 * (1 - warm * 0.66));
      d[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  return cv;
}

/* -------------------------------------------------------------- flash ---- */

/** 2x2 muzzle-flash atlas: star, petal cone, round bloom, anamorphic cross. */
function flashAtlas(tile = 192, seed = 17) {
  const W = tile * 2, H = tile * 2;
  const cv = mkCanvas(W, H);
  const g = cv.getContext('2d');
  const rng = makeRNG(seed);

  const core = (cx, cy, r, power = 1) => {
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0.00, `rgba(255,255,255,${0.98 * power})`);
    grad.addColorStop(0.14, `rgba(255,255,255,${0.72 * power})`);
    grad.addColorStop(0.32, `rgba(255,250,240,${0.32 * power})`);
    grad.addColorStop(0.58, `rgba(255,236,206,${0.10 * power})`);
    grad.addColorStop(1.00, 'rgba(255,220,180,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  };

  g.globalCompositeOperation = 'lighter';

  for (let f = 0; f < 4; f++) {
    const ox = (f % 2) * tile, oy = Math.floor(f / 2) * tile;
    const cx = ox + tile * 0.5, cy = oy + tile * 0.5;
    const R = tile * 0.48;

    if (f === 0) {
      // star burst: core + tapered spikes
      core(cx, cy, R * 0.42, 1);
      const spikes = 9;
      for (let i = 0; i < spikes; i++) {
        const a = (i / spikes) * Math.PI * 2 + rng() * 0.25;
        const len = R * (0.55 + rng() * 0.45);
        const wid = R * (0.030 + rng() * 0.045);
        g.save();
        g.translate(cx, cy); g.rotate(a);
        const grad = g.createLinearGradient(0, 0, len, 0);
        grad.addColorStop(0, 'rgba(255,255,255,0.85)');
        grad.addColorStop(0.35, 'rgba(255,238,205,0.30)');
        grad.addColorStop(1, 'rgba(255,190,120,0)');
        g.fillStyle = grad;
        g.beginPath();
        g.moveTo(0, -wid); g.lineTo(len * 0.55, -wid * 0.42);
        g.lineTo(len, 0); g.lineTo(len * 0.55, wid * 0.42); g.lineTo(0, wid);
        g.closePath(); g.fill();
        g.restore();
      }
    } else if (f === 1) {
      // petal cone — the classic three-lobe flash flower
      core(cx, cy, R * 0.34, 0.9);
      const lobes = 4;
      for (let i = 0; i < lobes; i++) {
        const a = (i / lobes) * Math.PI * 2 + 0.4 + rng() * 0.3;
        const len = R * (0.62 + rng() * 0.36);
        const spread = 0.34 + rng() * 0.22;
        g.save();
        g.translate(cx, cy); g.rotate(a);
        const grad = g.createRadialGradient(0, 0, 0, 0, 0, len);
        grad.addColorStop(0, 'rgba(255,255,255,0.80)');
        grad.addColorStop(0.30, 'rgba(255,241,208,0.40)');
        grad.addColorStop(0.70, 'rgba(255,186,104,0.11)');
        grad.addColorStop(1, 'rgba(255,140,60,0)');
        g.fillStyle = grad;
        g.beginPath();
        g.moveTo(0, 0);
        g.quadraticCurveTo(len * 0.55, -len * spread, len, 0);
        g.quadraticCurveTo(len * 0.55, len * spread, 0, 0);
        g.closePath(); g.fill();
        g.restore();
      }
    } else if (f === 2) {
      // round bloom
      core(cx, cy, R * 0.95, 1);
      core(cx, cy, R * 0.30, 0.8);
    } else {
      // anamorphic cross flare
      core(cx, cy, R * 0.34, 1);
      for (let i = 0; i < 2; i++) {
        const len = i === 0 ? R * 0.98 : R * 0.42;
        const wid = i === 0 ? R * 0.055 : R * 0.10;
        g.save();
        g.translate(cx, cy); g.rotate(i * Math.PI * 0.5);
        const grad = g.createLinearGradient(-len, 0, len, 0);
        grad.addColorStop(0.00, 'rgba(255,190,120,0)');
        grad.addColorStop(0.28, 'rgba(255,236,200,0.24)');
        grad.addColorStop(0.50, 'rgba(255,255,255,0.85)');
        grad.addColorStop(0.72, 'rgba(255,236,200,0.24)');
        grad.addColorStop(1.00, 'rgba(255,190,120,0)');
        g.fillStyle = grad;
        g.beginPath();
        g.moveTo(-len, 0); g.lineTo(0, -wid); g.lineTo(len, 0); g.lineTo(0, wid);
        g.closePath(); g.fill();
        g.restore();
      }
    }
  }
  g.globalCompositeOperation = 'source-over';
  return cv;
}

/* -------------------------------------------------------------- smoke ---- */

/** 2x2 billowing smoke atlas from domain-warped fbm. */
function smokeAtlas(tile = 176, seed = 3) {
  const W = tile * 2, H = tile * 2;
  const cv = mkCanvas(W, H);
  const g = cv.getContext('2d');
  const img = g.createImageData(W, H);
  const d = img.data;

  for (let f = 0; f < 4; f++) {
    const noise = makeNoise2D(seed * 131 + f * 17 + 5);
    const warp = makeNoise2D(seed * 977 + f * 31 + 3);
    const ox = (f % 2) * tile, oy = Math.floor(f / 2) * tile;
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        const u = (x + 0.5) / tile, v = (y + 0.5) / tile;
        const dx = u - 0.5, dy = v - 0.5;
        const r = Math.sqrt(dx * dx + dy * dy) * 2;

        const wx = fbm2D(warp, u * 2.1, v * 2.1, 3) * 0.9;
        const wy = fbm2D(warp, u * 2.1 + 5.3, v * 2.1 + 1.7, 3) * 0.9;
        let n = fbm2D(noise, u * 3.1 + wx, v * 3.1 + wy, 5, 2.07, 0.55);
        n = CLAMP(n * 1.95 + 0.5, 0, 1);

        // billowed radial mask — noise pushes the silhouette in and out
        const rr = r * (1.0 + (n - 0.5) * 0.62);
        const mask = 1 - S01((rr - 0.24) / 0.72);
        let a = Math.pow(mask, 1.22) * (0.26 + 0.74 * n);
        a = CLAMP(a * 1.45 - 0.055, 0, 1);

        // internal luminance so the puff has form before it is even lit
        const l = 0.55 + 0.45 * n;
        const i = ((oy + y) * W + (ox + x)) * 4;
        d[i] = Math.round(255 * l);
        d[i + 1] = Math.round(255 * l);
        d[i + 2] = Math.round(255 * l);
        d[i + 3] = Math.round(a * 255);
      }
    }
  }
  g.putImageData(img, 0, 0);
  return cv;
}

/* ------------------------------------------------------------ droplet ---- */

/** 2x2 blobs — blood mist, water spray. Near-white so the tint drives hue. */
function dropletAtlas(tile = 96, seed = 41) {
  const W = tile * 2, H = tile * 2;
  const cv = mkCanvas(W, H);
  const g = cv.getContext('2d');
  const img = g.createImageData(W, H);
  const d = img.data;

  for (let f = 0; f < 4; f++) {
    const noise = makeNoise2D(seed * 61 + f * 23 + 7);
    const ox = (f % 2) * tile, oy = Math.floor(f / 2) * tile;
    const squash = 1 + f * 0.16;
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        const u = (x + 0.5) / tile, v = (y + 0.5) / tile;
        const dx = (u - 0.5) * squash, dy = (v - 0.5) / squash;
        const r = Math.sqrt(dx * dx + dy * dy) * 2;
        let n = fbm2D(noise, u * 4.0, v * 4.0, 3, 2.1, 0.5);
        n = CLAMP(n * 2.0 + 0.5, 0, 1);
        const rr = r * (1.0 + (n - 0.5) * 0.40);
        let a = 1 - S01((rr - 0.42) / 0.42);
        a = Math.pow(a, 0.85);
        // wet highlight toward the top-left of the blob
        const hl = Math.max(0, 1 - Math.sqrt((u - 0.38) ** 2 + (v - 0.36) ** 2) * 5.2);
        const l = CLAMP(0.72 + 0.28 * n + hl * 0.6, 0, 1);
        const i = ((oy + y) * W + (ox + x)) * 4;
        d[i] = Math.round(255 * l);
        d[i + 1] = Math.round(255 * l);
        d[i + 2] = Math.round(255 * l);
        d[i + 3] = Math.round(a * 255);
      }
    }
  }
  g.putImageData(img, 0, 0);
  return cv;
}

/* --------------------------------------------------------------- chip ---- */

/** 2x2 debris chips — angular silhouettes with a baked top-lit gradient. */
function chipAtlas(tile = 80, seed = 61) {
  const W = tile * 2, H = tile * 2;
  const cv = mkCanvas(W, H);
  const g = cv.getContext('2d');
  const rng = makeRNG(seed);

  for (let f = 0; f < 4; f++) {
    const ox = (f % 2) * tile, oy = Math.floor(f / 2) * tile;
    const cx = ox + tile * 0.5, cy = oy + tile * 0.5;
    const n = 5 + Math.floor(rng() * 3);
    const rad = tile * (0.20 + rng() * 0.14);
    const el = 1 + rng() * 1.5;                     // elongation
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng() * 0.5;
      const rr = rad * (0.55 + rng() * 0.7);
      pts.push([cx + Math.cos(a) * rr * el, cy + Math.sin(a) * rr]);
    }
    const grad = g.createLinearGradient(cx, cy - rad, cx, cy + rad);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(176,176,176,1)');
    grad.addColorStop(1, 'rgba(74,74,74,1)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < n; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fill();
    // catch a specular sliver along the top edge
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.lineWidth = Math.max(1, tile * 0.018);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    g.lineTo(pts[1][0], pts[1][1]);
    g.stroke();
  }
  return cv;
}

/* -------------------------------------------------------------- shard ---- */

/** 2x2 glass shards — translucent bodies with bright refracting edges. */
function shardAtlas(tile = 96, seed = 83) {
  const W = tile * 2, H = tile * 2;
  const cv = mkCanvas(W, H);
  const g = cv.getContext('2d');
  const rng = makeRNG(seed);

  for (let f = 0; f < 4; f++) {
    const ox = (f % 2) * tile, oy = Math.floor(f / 2) * tile;
    const cx = ox + tile * 0.5, cy = oy + tile * 0.5;
    const L = tile * (0.30 + rng() * 0.14);
    const a0 = rng() * Math.PI * 2;
    const pts = [];
    for (let i = 0; i < 3; i++) {
      const a = a0 + (i / 3) * Math.PI * 2 + (rng() - 0.5) * 0.9;
      const rr = L * (0.5 + rng() * 1.0);
      pts.push([cx + Math.cos(a) * rr * 0.55, cy + Math.sin(a) * rr]);
    }
    const grad = g.createLinearGradient(cx - L, cy - L, cx + L, cy + L);
    grad.addColorStop(0, 'rgba(235,250,255,0.62)');
    grad.addColorStop(0.5, 'rgba(150,196,214,0.24)');
    grad.addColorStop(1, 'rgba(228,246,255,0.58)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    g.lineTo(pts[1][0], pts[1][1]);
    g.lineTo(pts[2][0], pts[2][1]);
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.lineWidth = Math.max(1, tile * 0.022);
    g.stroke();
  }
  return cv;
}

/* -------------------------------------------------------------- decal ---- */

/**
 * 4x2 decal atlas. Frames:
 *  0 concrete hole   1 metal strike   2 glass crack   3 blood splat
 *  4 scorch          5 sand crater    6 wood splinter 7 soft dust smudge
 */
function decalAtlas(tile = 192, seed = 97) {
  const cols = 4, rows = 2;
  const W = tile * cols, H = tile * rows;
  const cv = mkCanvas(W, H);
  const g = cv.getContext('2d');
  const rng = makeRNG(seed);

  const org = (f) => [(f % cols) * tile, Math.floor(f / cols) * tile];
  const jitterPath = (cx, cy, r0, r1, steps, wob) => {
    g.beginPath();
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const rr = r0 + (r1 - r0) * (0.5 + 0.5 * Math.sin(a * 3.1 + rng() * 0.4)) + (rng() - 0.5) * wob;
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
  };
  const crack = (cx, cy, a, len, w, style) => {
    g.strokeStyle = style;
    g.lineWidth = w;
    g.beginPath();
    let x = cx, y = cy, ang = a;
    g.moveTo(x, y);
    const seg = 5;
    for (let i = 0; i < seg; i++) {
      ang += (rng() - 0.5) * 0.6;
      x += Math.cos(ang) * (len / seg);
      y += Math.sin(ang) * (len / seg);
      g.lineTo(x, y);
    }
    g.stroke();
  };

  /* 0 — concrete bullet hole: dust halo, dark crater, hairline cracks */
  {
    const [ox, oy] = org(0), cx = ox + tile / 2, cy = oy + tile / 2, R = tile * 0.5;
    let gr = g.createRadialGradient(cx, cy, R * 0.10, cx, cy, R * 0.86);
    gr.addColorStop(0, 'rgba(214,208,196,0.50)');
    gr.addColorStop(0.42, 'rgba(196,190,178,0.26)');
    gr.addColorStop(1, 'rgba(180,174,162,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, R * 0.86, 0, 7); g.fill();
    for (let i = 0; i < 11; i++) crack(cx, cy, rng() * 7, R * (0.22 + rng() * 0.4), tile * 0.008, 'rgba(30,26,22,0.42)');
    gr = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.30);
    gr.addColorStop(0, 'rgba(16,13,11,0.97)');
    gr.addColorStop(0.45, 'rgba(26,22,19,0.80)');
    gr.addColorStop(0.80, 'rgba(52,46,40,0.32)');
    gr.addColorStop(1, 'rgba(70,63,55,0)');
    g.fillStyle = gr; jitterPath(cx, cy, R * 0.13, R * 0.24, 26, R * 0.03); g.fill();
    for (let i = 0; i < 26; i++) {
      const a = rng() * 7, d0 = R * (0.18 + rng() * 0.55);
      g.fillStyle = `rgba(34,29,25,${0.16 + rng() * 0.3})`;
      g.beginPath(); g.arc(cx + Math.cos(a) * d0, cy + Math.sin(a) * d0, tile * (0.006 + rng() * 0.014), 0, 7); g.fill();
    }
  }

  /* 1 — metal strike: bright scuffed rim, dark pit, radial scratches */
  {
    const [ox, oy] = org(1), cx = ox + tile / 2, cy = oy + tile / 2, R = tile * 0.5;
    let gr = g.createRadialGradient(cx, cy, R * 0.14, cx, cy, R * 0.55);
    gr.addColorStop(0, 'rgba(238,242,248,0.72)');
    gr.addColorStop(0.5, 'rgba(186,196,208,0.30)');
    gr.addColorStop(1, 'rgba(150,162,176,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, R * 0.55, 0, 7); g.fill();
    for (let i = 0; i < 22; i++) {
      const a = rng() * 7, len = R * (0.2 + rng() * 0.62);
      g.strokeStyle = `rgba(226,234,244,${0.10 + rng() * 0.34})`;
      g.lineWidth = tile * (0.004 + rng() * 0.008);
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * R * 0.10, cy + Math.sin(a) * R * 0.10);
      g.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      g.stroke();
    }
    gr = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.20);
    gr.addColorStop(0, 'rgba(12,14,18,0.94)');
    gr.addColorStop(0.6, 'rgba(30,34,40,0.62)');
    gr.addColorStop(1, 'rgba(60,66,74,0)');
    g.fillStyle = gr; jitterPath(cx, cy, R * 0.08, R * 0.16, 22, R * 0.02); g.fill();
  }

  /* 2 — glass crack star */
  {
    const [ox, oy] = org(2), cx = ox + tile / 2, cy = oy + tile / 2, R = tile * 0.5;
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + rng() * 0.3;
      crack(cx, cy, a, R * (0.4 + rng() * 0.5), tile * (0.006 + rng() * 0.008), `rgba(236,250,255,${0.32 + rng() * 0.45})`);
    }
    for (let r = 0; r < 3; r++) {
      const rr = R * (0.16 + r * 0.16);
      g.strokeStyle = `rgba(226,244,255,${0.30 - r * 0.07})`;
      g.lineWidth = tile * 0.006;
      g.beginPath();
      for (let i = 0; i <= 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        const d0 = rr * (0.82 + rng() * 0.36);
        const x = cx + Math.cos(a) * d0, y = cy + Math.sin(a) * d0;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath(); g.stroke();
    }
    const gr = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.14);
    gr.addColorStop(0, 'rgba(255,255,255,0.85)');
    gr.addColorStop(0.55, 'rgba(206,236,250,0.42)');
    gr.addColorStop(1, 'rgba(180,220,240,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, R * 0.14, 0, 7); g.fill();
  }

  /* 3 — blood splat */
  {
    const [ox, oy] = org(3), cx = ox + tile / 2, cy = oy + tile / 2, R = tile * 0.5;
    g.fillStyle = 'rgba(96,10,10,0.94)';
    jitterPath(cx, cy, R * 0.24, R * 0.42, 40, R * 0.09); g.fill();
    g.fillStyle = 'rgba(52,4,4,0.85)';
    jitterPath(cx, cy, R * 0.14, R * 0.26, 30, R * 0.06); g.fill();
    for (let i = 0; i < 26; i++) {
      const a = rng() * 7, d0 = R * (0.34 + rng() * 0.60);
      const rr = tile * (0.008 + rng() * 0.030);
      g.fillStyle = `rgba(${88 + rng() * 34 | 0},${8 + rng() * 10 | 0},${8 + rng() * 8 | 0},${0.45 + rng() * 0.5})`;
      g.beginPath(); g.ellipse(cx + Math.cos(a) * d0, cy + Math.sin(a) * d0, rr, rr * (0.6 + rng() * 0.9), a, 0, 7); g.fill();
    }
  }

  /* 4 — scorch smudge */
  {
    const [ox, oy] = org(4), cx = ox + tile / 2, cy = oy + tile / 2, R = tile * 0.5;
    for (let i = 0; i < 22; i++) {
      const a = rng() * 7, d0 = R * rng() * 0.42;
      const rr = R * (0.20 + rng() * 0.34);
      const gr = g.createRadialGradient(cx + Math.cos(a) * d0, cy + Math.sin(a) * d0, 0,
        cx + Math.cos(a) * d0, cy + Math.sin(a) * d0, rr);
      gr.addColorStop(0, 'rgba(12,10,9,0.30)');
      gr.addColorStop(1, 'rgba(20,17,15,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(cx + Math.cos(a) * d0, cy + Math.sin(a) * d0, rr, 0, 7); g.fill();
    }
  }

  /* 5 — sand crater: bright rim, dark bowl */
  {
    const [ox, oy] = org(5), cx = ox + tile / 2, cy = oy + tile / 2, R = tile * 0.5;
    let gr = g.createRadialGradient(cx, cy, R * 0.20, cx, cy, R * 0.68);
    gr.addColorStop(0, 'rgba(232,216,182,0)');
    gr.addColorStop(0.42, 'rgba(238,224,192,0.46)');
    gr.addColorStop(1, 'rgba(220,204,172,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, R * 0.70, 0, 7); g.fill();
    gr = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.30);
    gr.addColorStop(0, 'rgba(94,78,54,0.66)');
    gr.addColorStop(0.7, 'rgba(126,106,76,0.30)');
    gr.addColorStop(1, 'rgba(150,128,94,0)');
    g.fillStyle = gr; jitterPath(cx, cy, R * 0.16, R * 0.28, 28, R * 0.04); g.fill();
  }

  /* 6 — wood splinter hole */
  {
    const [ox, oy] = org(6), cx = ox + tile / 2, cy = oy + tile / 2, R = tile * 0.5;
    for (let i = 0; i < 16; i++) {
      const a = (rng() < 0.5 ? 0 : Math.PI) + (rng() - 0.5) * 0.7;
      const len = R * (0.24 + rng() * 0.52);
      g.strokeStyle = `rgba(${150 + rng() * 60 | 0},${112 + rng() * 44 | 0},${68 + rng() * 30 | 0},${0.24 + rng() * 0.42})`;
      g.lineWidth = tile * (0.006 + rng() * 0.014);
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len * 0.5);
      g.stroke();
    }
    const gr = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.26);
    gr.addColorStop(0, 'rgba(22,14,8,0.94)');
    gr.addColorStop(0.6, 'rgba(44,29,17,0.60)');
    gr.addColorStop(1, 'rgba(70,48,28,0)');
    g.fillStyle = gr; jitterPath(cx, cy, R * 0.12, R * 0.21, 22, R * 0.03); g.fill();
  }

  /* 7 — soft dust smudge */
  {
    const [ox, oy] = org(7), cx = ox + tile / 2, cy = oy + tile / 2, R = tile * 0.5;
    for (let i = 0; i < 14; i++) {
      const a = rng() * 7, d0 = R * rng() * 0.40;
      const rr = R * (0.24 + rng() * 0.40);
      const gr = g.createRadialGradient(cx + Math.cos(a) * d0, cy + Math.sin(a) * d0, 0,
        cx + Math.cos(a) * d0, cy + Math.sin(a) * d0, rr);
      gr.addColorStop(0, 'rgba(214,206,190,0.20)');
      gr.addColorStop(1, 'rgba(200,192,176,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(cx + Math.cos(a) * d0, cy + Math.sin(a) * d0, rr, 0, 7); g.fill();
    }
  }

  return cv;
}

/* --------------------------------------------------------------- API ----- */

export function buildVFXTextures(seed = 0x5F1E) {
  const out = {
    glow: null, streak: null, flash: null, smoke: null,
    droplet: null, chip: null, shard: null, decal: null,
    dispose() {
      for (const k of Object.keys(this)) {
        if (this[k] && this[k].isTexture) this[k].dispose();
      }
    },
  };
  if (typeof document === 'undefined') return out;

  out.glow = toTexture(glowTexture(128));
  out.streak = toTexture(streakTexture(256, 64));
  out.flash = toTexture(flashAtlas(192, seed ^ 0x11));
  out.smoke = toTexture(smokeAtlas(176, (seed & 0xff) + 3));
  out.droplet = toTexture(dropletAtlas(96, (seed & 0xff) + 41));
  out.chip = toTexture(chipAtlas(80, (seed & 0xff) + 61));
  out.shard = toTexture(shardAtlas(96, (seed & 0xff) + 83));
  out.decal = toTexture(decalAtlas(192, (seed & 0xff) + 97));
  return out;
}

export default buildVFXTextures;
