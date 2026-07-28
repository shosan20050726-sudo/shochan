import AI from './AIConfig.js';

/**
 * Navigation over `world.navGrid` — the walkability raster the world builds by
 * testing a player-sized capsule against the collision BVH.
 *
 * A* with a binary heap, string-pulled afterwards so bots walk diagonals
 * instead of stair-stepping along cell centres. All working arrays are
 * allocated once and versioned with a search stamp, so a search never clears
 * 80k cells and never allocates.
 *
 * Costs include a clearance penalty derived from a one-pass distance sweep, so
 * paths hug the middle of a corridor rather than scraping the walls — which is
 * what stops three bots merging into one conga line through a doorway.
 */

const SQRT2 = Math.SQRT2;
const NEI_X = [1, -1, 0, 0, 1, 1, -1, -1];
const NEI_Z = [0, 0, 1, -1, 1, -1, 1, -1];
const NEI_C = [1, 1, 1, 1, SQRT2, SQRT2, SQRT2, SQRT2];

export class NavMesh {
  constructor(grid) {
    this.grid = grid;
    this.w = grid?.width | 0;
    this.h = grid?.height | 0;
    this.cell = grid?.cellSize || 2.5;
    this.ox = grid?.origin?.x ?? 0;
    this.oz = grid?.origin?.z ?? 0;
    this.solid = grid?.solid || new Uint8Array(0);
    const n = this.w * this.h;

    this.clearance = new Uint8Array(n);
    this.g = new Float32Array(n);
    this.f = new Float32Array(n);
    this.from = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.state = new Uint8Array(n);        // 1 open, 2 closed
    // Worst case one push per expanded node per neighbour; sized so a search
    // can never silently drop an entry and return "no path" for a live route.
    this.heap = new Int32Array(Math.max(1024, Math.min(n, AI.nav.maxNodes * 8 + 64)));
    this.heapKey = new Float32Array(this.heap.length);
    this.heapLen = 0;
    this.version = 0;
    this.ready = n > 0;

    if (this.ready) this._buildClearance();
  }

  /**
   * Chebyshev distance-to-solid, capped at 3 cells. Cheap two-pass sweep.
   * Used both as a path cost and to reject cover points jammed into a corner.
   */
  _buildClearance() {
    const { w, h, solid, clearance } = this;
    const MAXC = 3;
    for (let i = 0; i < solid.length; i++) clearance[i] = solid[i] ? 0 : MAXC;
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        const i = z * w + x;
        if (!clearance[i]) continue;
        let best = MAXC;
        if (x > 0) best = Math.min(best, clearance[i - 1] + 1);
        if (z > 0) best = Math.min(best, clearance[i - w] + 1);
        if (x > 0 && z > 0) best = Math.min(best, clearance[i - w - 1] + 1);
        if (x < w - 1 && z > 0) best = Math.min(best, clearance[i - w + 1] + 1);
        clearance[i] = Math.min(clearance[i], best);
      }
    }
    for (let z = h - 1; z >= 0; z--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = z * w + x;
        if (!clearance[i]) continue;
        let best = clearance[i];
        if (x < w - 1) best = Math.min(best, clearance[i + 1] + 1);
        if (z < h - 1) best = Math.min(best, clearance[i + w] + 1);
        if (x < w - 1 && z < h - 1) best = Math.min(best, clearance[i + w + 1] + 1);
        if (x > 0 && z < h - 1) best = Math.min(best, clearance[i + w - 1] + 1);
        clearance[i] = best;
      }
    }
  }

  /* ------------------------------------------------------ coordinates -- */

  cx(x) { return Math.floor((x - this.ox) / this.cell); }
  cz(z) { return Math.floor((z - this.oz) / this.cell); }
  wx(i) { return this.ox + (i + 0.5) * this.cell; }
  wz(j) { return this.oz + (j + 0.5) * this.cell; }
  inside(i, j) { return i >= 0 && j >= 0 && i < this.w && j < this.h; }
  blocked(i, j) { return !this.inside(i, j) || this.solid[j * this.w + i] !== 0; }
  walkable(x, z) { return !this.blocked(this.cx(x), this.cz(z)); }

  /** Nearest walkable cell index to a world point, searched in rings. */
  nearestFree(x, z, maxRings = 6) {
    let i = this.cx(x), j = this.cz(z);
    if (!this.blocked(i, j)) return j * this.w + i;
    for (let r = 1; r <= maxRings; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const a = i + dx, b = j + dz;
          if (!this.blocked(a, b)) return b * this.w + a;
        }
      }
    }
    return -1;
  }

  /* ------------------------------------------------------------- heap -- */

  _push(idx, key) {
    let n = this.heapLen;
    if (n >= this.heap.length) return;
    this.heap[n] = idx; this.heapKey[n] = key;
    this.heapLen++;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (this.heapKey[p] <= this.heapKey[n]) break;
      const ti = this.heap[p], tk = this.heapKey[p];
      this.heap[p] = this.heap[n]; this.heapKey[p] = this.heapKey[n];
      this.heap[n] = ti; this.heapKey[n] = tk;
      n = p;
    }
  }

  _pop() {
    if (this.heapLen === 0) return -1;
    const top = this.heap[0];
    this.heapLen--;
    if (this.heapLen > 0) {
      this.heap[0] = this.heap[this.heapLen];
      this.heapKey[0] = this.heapKey[this.heapLen];
      let n = 0;
      for (;;) {
        const l = n * 2 + 1, r = l + 1;
        let s = n;
        if (l < this.heapLen && this.heapKey[l] < this.heapKey[s]) s = l;
        if (r < this.heapLen && this.heapKey[r] < this.heapKey[s]) s = r;
        if (s === n) break;
        const ti = this.heap[s], tk = this.heapKey[s];
        this.heap[s] = this.heap[n]; this.heapKey[s] = this.heapKey[n];
        this.heap[n] = ti; this.heapKey[n] = tk;
        n = s;
      }
    }
    return top;
  }

  /* --------------------------------------------------------------- A* -- */

  /**
   * @param {Float32Array} out  flat [x,z, x,z, ...] destination
   * @returns {number} number of waypoints written (0 = no path)
   */
  findPath(sx, sz, gx, gz, out, maxPoints = 24) {
    if (!this.ready) return 0;
    const start = this.nearestFree(sx, sz);
    const goal = this.nearestFree(gx, gz, 8);
    if (start < 0 || goal < 0) return 0;
    if (start === goal) {
      out[0] = gx; out[1] = gz;
      return 1;
    }

    const w = this.w;
    const gi = goal % w, gj = (goal / w) | 0;
    const version = ++this.version;
    this.heapLen = 0;

    this.stamp[start] = version;
    this.g[start] = 0;
    this.from[start] = -1;
    this.state[start] = 1;
    this._push(start, this._heur(start % w, (start / w) | 0, gi, gj));

    let expanded = 0;
    let found = false;
    const maxNodes = AI.nav.maxNodes;
    const cw = AI.nav.clearanceWeight;

    while (this.heapLen > 0 && expanded < maxNodes) {
      const cur = this._pop();
      if (cur < 0) break;
      if (this.stamp[cur] !== version || this.state[cur] === 2) continue;
      this.state[cur] = 2;
      expanded++;
      if (cur === goal) { found = true; break; }

      const ci = cur % w, cj = (cur / w) | 0;
      const gcur = this.g[cur];

      for (let k = 0; k < 8; k++) {
        const ni = ci + NEI_X[k], nj = cj + NEI_Z[k];
        if (this.blocked(ni, nj)) continue;
        // No corner cutting: a diagonal needs both orthogonals open.
        if (k >= 4 && (this.blocked(ci + NEI_X[k], cj) || this.blocked(ci, cj + NEI_Z[k]))) continue;
        const n = nj * w + ni;
        if (this.stamp[n] === version && this.state[n] === 2) continue;

        const clear = this.clearance[n];
        const penalty = clear >= 3 ? 0 : (3 - clear) * cw;
        const ng = gcur + NEI_C[k] + penalty;

        if (this.stamp[n] !== version) {
          this.stamp[n] = version;
          this.state[n] = 0;
          this.g[n] = Infinity;
        }
        if (ng < this.g[n]) {
          this.g[n] = ng;
          this.from[n] = cur;
          this.state[n] = 1;
          this._push(n, ng + this._heur(ni, nj, gi, gj));
        }
      }
    }

    if (!found) return 0;

    // Walk back, writing into a temporary reverse buffer.
    let node = goal, count = 0;
    const rev = this._rev ||= new Int32Array(AI.nav.maxNodes + 64);
    while (node >= 0 && count < rev.length) {
      rev[count++] = node;
      node = this.stamp[node] === version ? this.from[node] : -1;
    }
    if (count < 1) return 0;

    // Reverse into world coordinates, then string-pull.
    const raw = this._raw ||= new Float32Array((AI.nav.maxNodes + 64) * 2);
    let m = 0;
    for (let i = count - 1; i >= 0; i--) {
      const idx = rev[i];
      raw[m * 2] = this.wx(idx % w);
      raw[m * 2 + 1] = this.wz((idx / w) | 0);
      m++;
    }
    // Snap the ends to the true start/goal so bots do not detour to a centre.
    raw[0] = sx; raw[1] = sz;
    raw[(m - 1) * 2] = gx; raw[(m - 1) * 2 + 1] = gz;

    return this._smooth(raw, m, out, maxPoints);
  }

  _heur(ax, az, bx, bz) {
    const dx = Math.abs(ax - bx), dz = Math.abs(az - bz);
    // Octile: exact for 8-connected movement, so A* stays admissible.
    return (dx + dz) + (SQRT2 - 2) * Math.min(dx, dz);
  }

  /** String pull: keep a waypoint only when the straight line would clip. */
  _smooth(raw, count, out, maxPoints) {
    let n = 0;
    out[n * 2] = raw[0]; out[n * 2 + 1] = raw[1]; n++;
    let anchor = 0;
    for (let i = 1; i < count; i++) {
      const canSee = this.lineOfSight(raw[anchor * 2], raw[anchor * 2 + 1], raw[i * 2], raw[i * 2 + 1]);
      if (!canSee) {
        const prev = i - 1;
        if (prev > anchor && n < maxPoints - 1) {
          out[n * 2] = raw[prev * 2]; out[n * 2 + 1] = raw[prev * 2 + 1]; n++;
        }
        anchor = prev;
      }
    }
    if (n < maxPoints) {
      out[n * 2] = raw[(count - 1) * 2]; out[n * 2 + 1] = raw[(count - 1) * 2 + 1]; n++;
    }
    return n;
  }

  /** Supercover grid walk: false as soon as a solid cell is entered. */
  lineOfSight(x0, z0, x1, z1) {
    let i = this.cx(x0), j = this.cz(z0);
    const ie = this.cx(x1), je = this.cz(z1);
    if (this.blocked(i, j) || this.blocked(ie, je)) return false;
    const dx = x1 - x0, dz = z1 - z0;
    const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const cell = this.cell;
    const nextX = this.ox + (i + (dx > 0 ? 1 : 0)) * cell;
    const nextZ = this.oz + (j + (dz > 0 ? 1 : 0)) * cell;
    let tMaxX = Math.abs(dx) < 1e-9 ? Infinity : (nextX - x0) / dx;
    let tMaxZ = Math.abs(dz) < 1e-9 ? Infinity : (nextZ - z0) / dz;
    const tDeltaX = Math.abs(dx) < 1e-9 ? Infinity : cell / Math.abs(dx);
    const tDeltaZ = Math.abs(dz) < 1e-9 ? Infinity : cell / Math.abs(dz);

    for (let guard = 0; guard < 512; guard++) {
      if (i === ie && j === je) return true;
      // The rest of the segment lies inside the current cell: nothing left.
      if (tMaxX > 1 && tMaxZ > 1) return true;
      if (tMaxX < tMaxZ) { i += stepX; tMaxX += tDeltaX; }
      else { j += stepZ; tMaxZ += tDeltaZ; }
      if (this.blocked(i, j)) return false;
    }
    return false;
  }

  /** Clearance in metres at a world point (0 = solid / against a wall). */
  clearanceAt(x, z) {
    const i = this.cx(x), j = this.cz(z);
    if (!this.inside(i, j)) return 0;
    return this.clearance[j * this.w + i] * this.cell;
  }
}

export default NavMesh;
