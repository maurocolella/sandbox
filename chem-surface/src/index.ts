export type Vec3 = { x: number; y: number; z: number };
export type Atom = Vec3 & { radius: number };

export interface SurfaceOptions {
  probeRadius?: number; // Å, default 1.4
  voxelSize?: number; // grid spacing in Å, default 0.5 (coarsened automatically to respect maxGridPoints)
  maxGridPoints?: number; // upper bound on grid nodes, default 8M
  signal?: AbortSignal;
}

export interface SurfaceGeometry {
  positions: Float32Array;
  normals: Float32Array;
  indices?: Uint32Array;
  atomIndex?: Uint32Array; // nearest atom per vertex (by distance to its VDW sphere)
}

// Pipeline: signed distance fields on a regular grid (negative inside), isosurface at 0 via surface nets.
//  - VDW: min_i |p - c_i| - r_i
//  - SAS: min_i |p - c_i| - (r_i + probe)
//  - SES: probe - D(p), D = distance to the SAS exterior, propagated from exact SAS surface points;
//         combined with the VDW field so the surface never cuts into an atom.

const FAR = 1e4;

export interface Grid {
  ox: number; oy: number; oz: number; // origin (Å)
  h: number; // spacing (Å)
  nx: number; ny: number; nz: number;
}


export function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Surface generation aborted", "AbortError");
}

function makeGrid(atoms: Atom[], pad: number, opts: SurfaceOptions): Grid {
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (const a of atoms) {
    const r = a.radius + pad;
    minx = Math.min(minx, a.x - r); miny = Math.min(miny, a.y - r); minz = Math.min(minz, a.z - r);
    maxx = Math.max(maxx, a.x + r); maxy = Math.max(maxy, a.y + r); maxz = Math.max(maxz, a.z + r);
  }
  const maxNodes = opts.maxGridPoints ?? 8_000_000;
  let h = Math.max(0.1, opts.voxelSize ?? 0.5);
  const volume = (maxx - minx) * (maxy - miny) * (maxz - minz);
  h = Math.max(h, Math.cbrt(volume / maxNodes));
  // Two spare nodes on each side keep the isosurface off the grid border
  const ox = minx - 2 * h, oy = miny - 2 * h, oz = minz - 2 * h;
  const nx = Math.ceil((maxx - minx) / h) + 5, ny = Math.ceil((maxy - miny) / h) + 5, nz = Math.ceil((maxz - minz) / h) + 5;
  return { ox, oy, oz, h, nx, ny, nz };
}

/** Splat min(|p - c| - r - inflate) for every atom over nodes within `band` of its sphere. */
function sphereField(g: Grid, atoms: Atom[], inflate: number, band: number, out: Float32Array, signal?: AbortSignal) {
  const { ox, oy, oz, h, nx, ny, nz } = g;
  for (let ai = 0; ai < atoms.length; ai++) {
    if ((ai & 1023) === 0) checkAbort(signal);
    const a = atoms[ai]!;
    const R = a.radius + inflate;
    const reach = R + band;
    const i0 = Math.max(0, Math.floor((a.x - reach - ox) / h)), i1 = Math.min(nx - 1, Math.ceil((a.x + reach - ox) / h));
    const j0 = Math.max(0, Math.floor((a.y - reach - oy) / h)), j1 = Math.min(ny - 1, Math.ceil((a.y + reach - oy) / h));
    const k0 = Math.max(0, Math.floor((a.z - reach - oz) / h)), k1 = Math.min(nz - 1, Math.ceil((a.z + reach - oz) / h));
    const reach2 = reach * reach;
    for (let i = i0; i <= i1; i++) {
      const dx = ox + i * h - a.x, dx2 = dx * dx;
      for (let j = j0; j <= j1; j++) {
        const dy = oy + j * h - a.y, dxy2 = dx2 + dy * dy;
        if (dxy2 > reach2) continue;
        let n = (i * ny + j) * nz + k0;
        for (let k = k0; k <= k1; k++, n++) {
          const dz = oz + k * h - a.z;
          const d2 = dxy2 + dz * dz;
          if (d2 > reach2) continue;
          const v = Math.sqrt(d2) - R;
          if (v < out[n]!) out[n] = v;
        }
      }
    }
  }
}

/** Uniform hash of atoms for nearest-sphere queries. */
class AtomHash {
  private cell: number;
  private maxR = 0;
  private map = new Map<number, number[]>();
  constructor(private atoms: Atom[], cell: number) {
    this.cell = cell;
    atoms.forEach((a, i) => {
      this.maxR = Math.max(this.maxR, a.radius);
      const key = this.key(Math.floor(a.x / cell), Math.floor(a.y / cell), Math.floor(a.z / cell));
      let list = this.map.get(key);
      if (!list) { list = []; this.map.set(key, list); }
      list.push(i);
    });
  }
  private key(i: number, j: number, k: number) { return ((i + 1024) * 2048 + (j + 1024)) * 2048 + (k + 1024); }
  /** Atom minimising |p - c| - (r + inflate), searching rings until a hit is certain. */
  nearest(x: number, y: number, z: number, inflate: number): number {
    const ci = Math.floor(x / this.cell), cj = Math.floor(y / this.cell), ck = Math.floor(z / this.cell);
    let best = -1, bestV = Infinity;
    for (let ring = 1; ring <= 64; ring++) {
      for (let i = ci - ring; i <= ci + ring; i++) for (let j = cj - ring; j <= cj + ring; j++) for (let k = ck - ring; k <= ck + ring; k++) {
        if (ring > 1 && Math.abs(i - ci) < ring && Math.abs(j - cj) < ring && Math.abs(k - ck) < ring) continue;
        const list = this.map.get(this.key(i, j, k));
        if (!list) continue;
        for (const ai of list) {
          const a = this.atoms[ai]!;
          const v = Math.hypot(x - a.x, y - a.y, z - a.z) - a.radius - inflate;
          if (v < bestV) { bestV = v; best = ai; }
        }
      }
      // Unsearched atoms have centres at least ring * cell away, so they score >= ring * cell - maxR - inflate
      if (best >= 0 && bestV <= ring * this.cell - this.maxR - inflate) break;
    }
    return best;
  }
}

const NB26: Array<[number, number, number]> = [];
for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
  if (di || dj || dk) NB26.push([di, dj, dk]);
}

/**
 * Exact samples of the SAS concave creases: the circles where two inflated spheres intersect, keeping
 * only points not buried in a third sphere. These are the nearest SAS points for reentrant SES regions,
 * which projected grid seeds only approximate.
 */
function creaseSeeds(atoms: Atom[], probe: number, spacing: number, out: number[]) {
  let maxR = 0;
  for (const a of atoms) maxR = Math.max(maxR, a.radius + probe);
  const cell = 2 * maxR;
  const grid = new Map<string, number[]>();
  atoms.forEach((a, i) => {
    const key = `${Math.floor(a.x / cell)},${Math.floor(a.y / cell)},${Math.floor(a.z / cell)}`;
    (grid.get(key) ?? grid.set(key, []).get(key)!).push(i);
  });
  // Intersecting neighbours per atom
  const nbrs: number[][] = atoms.map(() => []);
  atoms.forEach((a, i) => {
    const ci = Math.floor(a.x / cell), cj = Math.floor(a.y / cell), ck = Math.floor(a.z / cell);
    const Ri = a.radius + probe;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
      for (const j of grid.get(`${ci + di},${cj + dj},${ck + dk}`) ?? []) {
        if (j === i) continue;
        const b = atoms[j]!;
        if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < Ri + b.radius + probe) nbrs[i]!.push(j);
      }
    }
  });
  // Each pair is sampled once, oriented by coordinates rather than list order, so the samples don't
  // depend on how the atoms are ordered (bricks gather them in a different order)
  const before = (p: Atom, q: Atom) => p.x < q.x || (p.x === q.x && (p.y < q.y || (p.y === q.y && p.z < q.z)));
  for (let i0 = 0; i0 < atoms.length; i0++) {
    for (const j0 of nbrs[i0]!) {
      if (j0 < i0) continue;
      const [i, j] = before(atoms[i0]!, atoms[j0]!) ? [i0, j0] : [j0, i0];
      const a = atoms[i]!, Ri = a.radius + probe;
      const b = atoms[j]!, Rj = b.radius + probe;
      const ux0 = b.x - a.x, uy0 = b.y - a.y, uz0 = b.z - a.z;
      const dij = Math.hypot(ux0, uy0, uz0);
      if (dij < 1e-6 || dij <= Math.abs(Ri - Rj)) continue;
      const ux = ux0 / dij, uy = uy0 / dij, uz = uz0 / dij;
      const along = (dij * dij + Ri * Ri - Rj * Rj) / (2 * dij);
      const rho = Math.sqrt(Math.max(0, Ri * Ri - along * along));
      if (rho < 1e-6) continue;
      // Orthonormal basis (e1, e2) perpendicular to u
      const ax = Math.abs(ux) < 0.9 ? 1 : 0, ay = 1 - ax;
      let e1x = -uz * ay, e1y = uz * ax, e1z = ux * ay - uy * ax; // u x (ax, ay, 0)
      const l1 = Math.hypot(e1x, e1y, e1z); e1x /= l1; e1y /= l1; e1z /= l1;
      const e2x = uy * e1z - uz * e1y, e2y = uz * e1x - ux * e1z, e2z = ux * e1y - uy * e1x;
      const cx = a.x + ux * along, cy = a.y + uy * along, cz = a.z + uz * along;
      const steps = Math.max(8, Math.ceil((2 * Math.PI * rho) / spacing));
      for (let s = 0; s < steps; s++) {
        const t = (2 * Math.PI * s) / steps, ct = Math.cos(t) * rho, st = Math.sin(t) * rho;
        const qx = cx + e1x * ct + e2x * st, qy = cy + e1y * ct + e2y * st, qz = cz + e1z * ct + e2z * st;
        let buried = false;
        for (const k of nbrs[i]!) {
          if (k === j) continue;
          const c = atoms[k]!, Rk = c.radius + probe;
          const ex = qx - c.x, ey = qy - c.y, ez = qz - c.z;
          if (ex * ex + ey * ey + ez * ez < Rk * Rk - 1e-6) { buried = true; break; }
        }
        if (!buried) out.push(qx, qy, qz);
      }
    }
  }
}

/**
 * SES field: for nodes inside the SAS, D = distance to the nearest exact SAS surface point. Seeds come from
 * outside nodes next to the SAS projected onto their nearest inflated sphere (always an exposed surface
 * point). Since D >= depth inside the SAS (-fsas), only nodes shallower than probe + 2h need a query, and
 * each one takes the exact minimum over seeds in a spatial hash. Returns probe - D, capped deep inside.
 */
function sesField(g: Grid, atoms: Atom[], probe: number, fsas: Float32Array, hash: AtomHash, signal?: AbortSignal): Float32Array {
  const { ox, oy, oz, h, nx, ny, nz } = g;
  const total = nx * ny * nz;
  const limit = probe + 2 * h;

  // Seeds: outside nodes with an inside neighbour, projected onto the SAS
  const seedList: number[] = [];
  for (let i = 1; i < nx - 1; i++) {
    checkAbort(signal);
    for (let j = 1; j < ny - 1; j++) for (let k = 1; k < nz - 1; k++) {
      const n = (i * ny + j) * nz + k;
      if (fsas[n]! < 0 || fsas[n]! > 2 * h) continue;
      let touchesInside = false;
      for (const [di, dj, dk] of NB26) if (fsas[n + (di * ny + dj) * nz + dk]! < 0) { touchesInside = true; break; }
      if (!touchesInside) continue;
      const px = ox + i * h, py = oy + j * h, pz = oz + k * h;
      const ai = hash.nearest(px, py, pz, probe);
      if (ai < 0) continue;
      const a = atoms[ai]!;
      const dx = px - a.x, dy = py - a.y, dz = pz - a.z;
      const s = (a.radius + probe) / (Math.hypot(dx, dy, dz) || 1);
      seedList.push(a.x + dx * s, a.y + dy * s, a.z + dz * s);
    }
  }

  creaseSeeds(atoms, probe, h * 0.5, seedList);

  // Bucket seeds into cells of size `limit`, sorted by cell so each bucket is a contiguous range
  const cs = limit;
  const cnx = Math.ceil((nx * h) / cs) + 1, cny = Math.ceil((ny * h) / cs) + 1, cnz = Math.ceil((nz * h) / cs) + 1;
  const seedCount = seedList.length / 3;
  const cellOfSeed = new Int32Array(seedCount);
  const cellStart = new Int32Array(cnx * cny * cnz + 1);
  for (let s = 0; s < seedCount; s++) {
    const ci = Math.floor((seedList[s * 3]! - ox) / cs), cj = Math.floor((seedList[s * 3 + 1]! - oy) / cs), ck = Math.floor((seedList[s * 3 + 2]! - oz) / cs);
    const c = (Math.min(cnx - 1, Math.max(0, ci)) * cny + Math.min(cny - 1, Math.max(0, cj))) * cnz + Math.min(cnz - 1, Math.max(0, ck));
    cellOfSeed[s] = c;
    cellStart[c + 1]!++;
  }
  for (let c = 0; c < cnx * cny * cnz; c++) cellStart[c + 1]! += cellStart[c]!;
  const fill = cellStart.slice(0, -1);
  const seeds = new Float32Array(seedCount * 3);
  for (let s = 0; s < seedCount; s++) {
    const o = fill[cellOfSeed[s]!]!++ * 3;
    seeds[o] = seedList[s * 3]!; seeds[o + 1] = seedList[s * 3 + 1]!; seeds[o + 2] = seedList[s * 3 + 2]!;
  }

  const out = new Float32Array(total);
  const limit2 = limit * limit;
  for (let i = 0; i < nx; i++) {
    checkAbort(signal);
    const px = ox + i * h, ci = Math.floor((px - ox) / cs);
    for (let j = 0; j < ny; j++) {
      const py = oy + j * h, cj = Math.floor((py - oy) / cs);
      for (let k = 0; k < nz; k++) {
        const n = (i * ny + j) * nz + k;
        const fs = fsas[n]!;
        if (fs >= 0) { out[n] = probe; continue; }
        if (fs <= -limit) { out[n] = probe - limit; continue; }
        const pz = oz + k * h, ck = Math.floor((pz - oz) / cs);
        let best = limit2;
        for (let a = Math.max(0, ci - 1); a <= Math.min(cnx - 1, ci + 1); a++) {
          for (let b = Math.max(0, cj - 1); b <= Math.min(cny - 1, cj + 1); b++) {
            const row = (a * cny + b) * cnz;
            const s0 = cellStart[row + Math.max(0, ck - 1)]!, s1 = cellStart[row + Math.min(cnz - 1, ck + 1) + 1]!;
            for (let s = s0; s < s1; s++) {
              const dx = seeds[s * 3]! - px, dy = seeds[s * 3 + 1]! - py, dz = seeds[s * 3 + 2]! - pz;
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 < best) best = d2;
            }
          }
        }
        // Capped at the query limit, so the field depends only on seeds within reach (bricks see exactly those)
        out[n] = probe - Math.sqrt(Math.min(best, limit2));
      }
    }
  }
  return out;
}

class FloatBuilder {
  data: Float32Array;
  length = 0;
  constructor(capacity: number) { this.data = new Float32Array(Math.max(16, capacity)); }
  push3(x: number, y: number, z: number) {
    if (this.length + 3 > this.data.length) { const d = new Float32Array(this.data.length * 2); d.set(this.data); this.data = d; }
    this.data[this.length++] = x; this.data[this.length++] = y; this.data[this.length++] = z;
  }
}

class IndexBuilder {
  data: Uint32Array;
  length = 0;
  constructor(capacity: number) { this.data = new Uint32Array(Math.max(16, capacity)); }
  quad(a: number, b: number, c: number, d: number) {
    if (this.length + 6 > this.data.length) { const n = new Uint32Array(this.data.length * 2); n.set(this.data); this.data = n; }
    const o = this.data;
    o[this.length++] = a; o[this.length++] = b; o[this.length++] = c;
    o[this.length++] = a; o[this.length++] = c; o[this.length++] = d;
  }
}

// Cube corners (di, dj, dk) and the 12 edges between them
const CORNERS: Array<[number, number, number]> = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
const EDGES: Array<[number, number]> = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

/**
 * Surface nets on the zero level set of f (negative inside). One vertex per crossing cell at the mean of
 * its interpolated edge crossings; one quad per crossing grid edge, wound so the normal points outward.
 * Normals come from the analytic gradient of the trilinear field in the vertex's cell.
 */
/** Node range [i0, i1) x [j0, j1) x [k0, k1) whose edges a mesh owns (a brick's core; default: all). */
export interface EmitRange { i0: number; i1: number; j0: number; j1: number; k0: number; k1: number }

export function surfaceNets(g: Grid, f: Float32Array, signal?: AbortSignal, range?: EmitRange) {
  const { ox, oy, oz, h, nx, ny, nz } = g;
  const cny = ny - 1, cnz = nz - 1;
  // Cells next to an owned edge, and owned edges (quads around them)
  const r = range ?? { i0: 0, i1: nx, j0: 0, j1: ny, k0: 0, k1: nz };
  const ci0 = Math.max(0, r.i0 - 1), ci1 = Math.min(nx - 1, r.i1), cj0 = Math.max(0, r.j0 - 1), cj1 = Math.min(ny - 1, r.j1), ck0 = Math.max(0, r.k0 - 1), ck1 = Math.min(nz - 1, r.k1);
  const cellVert = new Int32Array((nx - 1) * cny * cnz).fill(-1);
  const pos = new FloatBuilder(1 << 16);
  const nrm = new FloatBuilder(1 << 16);
  const idx = new IndexBuilder(1 << 17);
  const v = new Float64Array(8);

  for (let i = ci0; i < ci1; i++) {
    checkAbort(signal);
    for (let j = cj0; j < cj1; j++) for (let k = ck0; k < ck1; k++) {
      let mask = 0;
      for (let c = 0; c < 8; c++) {
        const [di, dj, dk] = CORNERS[c]!;
        v[c] = f[((i + di) * ny + (j + dj)) * nz + (k + dk)]!;
        if (v[c]! < 0) mask |= 1 << c;
      }
      if (mask === 0 || mask === 0xff) continue;
      let sx = 0, sy = 0, sz = 0, cnt = 0;
      for (const [a, b] of EDGES) {
        const va = v[a]!, vb = v[b]!;
        if ((va < 0) === (vb < 0)) continue;
        const t = va / (va - vb);
        const A = CORNERS[a]!, B = CORNERS[b]!;
        sx += A[0] + (B[0] - A[0]) * t; sy += A[1] + (B[1] - A[1]) * t; sz += A[2] + (B[2] - A[2]) * t;
        cnt++;
      }
      const fx = sx / cnt, fy = sy / cnt, fz = sz / cnt;
      cellVert[(i * cny + j) * cnz + k] = pos.length / 3;
      pos.push3(ox + (i + fx) * h, oy + (j + fy) * h, oz + (k + fz) * h);
      // Gradient of the trilinear interpolant at (fx, fy, fz); f increases outward
      const gx = (1 - fy) * (1 - fz) * (v[1]! - v[0]!) + fy * (1 - fz) * (v[3]! - v[2]!) + (1 - fy) * fz * (v[5]! - v[4]!) + fy * fz * (v[7]! - v[6]!);
      const gy = (1 - fx) * (1 - fz) * (v[2]! - v[0]!) + fx * (1 - fz) * (v[3]! - v[1]!) + (1 - fx) * fz * (v[6]! - v[4]!) + fx * fz * (v[7]! - v[5]!);
      const gz = (1 - fx) * (1 - fy) * (v[4]! - v[0]!) + fx * (1 - fy) * (v[5]! - v[1]!) + (1 - fx) * fy * (v[6]! - v[2]!) + fx * fy * (v[7]! - v[3]!);
      const len = Math.hypot(gx, gy, gz) || 1;
      nrm.push3(gx / len, gy / len, gz / len);
    }
  }

  const cell = (i: number, j: number, k: number) => cellVert[(i * cny + j) * cnz + k]!;
  // Emit a quad around a crossing edge; a..d go counter-clockwise seen from the edge's +axis side
  const emit = (insideAtLow: boolean, a: number, b: number, c: number, d: number) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (insideAtLow) idx.quad(a, b, c, d); else idx.quad(a, d, c, b);
  };
  for (let i = Math.max(1, r.i0); i < Math.min(nx - 1, r.i1); i++) {
    checkAbort(signal);
    for (let j = Math.max(1, r.j0); j < Math.min(ny - 1, r.j1); j++) for (let k = Math.max(1, r.k0); k < Math.min(nz - 1, r.k1); k++) {
      const n = (i * ny + j) * nz + k;
      const inside = f[n]! < 0;
      // x-edge (i,j,k)->(i+1,j,k): cells around it in the (y, z) plane
      if (i < nx - 2 && inside !== (f[n + ny * nz]! < 0)) {
        emit(inside, cell(i, j - 1, k - 1), cell(i, j, k - 1), cell(i, j, k), cell(i, j - 1, k));
      }
      // y-edge: cells in the (z, x) plane
      if (j < ny - 2 && inside !== (f[n + nz]! < 0)) {
        emit(inside, cell(i - 1, j, k - 1), cell(i - 1, j, k), cell(i, j, k), cell(i, j, k - 1));
      }
      // z-edge: cells in the (x, y) plane
      if (k < nz - 2 && inside !== (f[n + 1]! < 0)) {
        emit(inside, cell(i - 1, j - 1, k), cell(i, j - 1, k), cell(i, j, k), cell(i - 1, j, k));
      }
    }
  }

  return {
    positions: pos.data.slice(0, pos.length),
    normals: nrm.data.slice(0, nrm.length),
    indices: idx.data.slice(0, idx.length),
  };
}

function assignAtoms(atoms: Atom[], positions: Float32Array, hash: AtomHash): Uint32Array {
  const out = new Uint32Array(positions.length / 3);
  for (let v = 0; v < out.length; v++) {
    out[v] = Math.max(0, hash.nearest(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!, 0));
  }
  return out;
}

export type SurfaceKind = "vdw" | "sas" | "ses";
type Kind = SurfaceKind;

export function generate(kind: Kind, atoms: Atom[], opts: SurfaceOptions): SurfaceGeometry {
  if (atoms.length === 0) return { positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0), atomIndex: new Uint32Array(0) };
  const probe = opts.probeRadius ?? 1.4;
  const signal = opts.signal;
  const g = makeGrid(atoms, kind === "vdw" ? 0 : probe, opts);
  const total = g.nx * g.ny * g.nz;
  const band = 2 * g.h;
  const hash = new AtomHash(atoms, 4);

  let f: Float32Array;
  if (kind === "vdw") {
    f = new Float32Array(total).fill(FAR);
    sphereField(g, atoms, 0, band, f, signal);
  } else if (kind === "sas") {
    f = new Float32Array(total).fill(FAR);
    sphereField(g, atoms, probe, band, f, signal);
  } else {
    // SAS field must be exact wherever D is propagated (up to probe + band inside it)
    const fsas = new Float32Array(total).fill(FAR);
    sphereField(g, atoms, probe, band, fsas, signal);
    f = sesField(g, atoms, probe, fsas, hash, signal);
    const fvdw = fsas.fill(FAR); // reuse the buffer
    sphereField(g, atoms, 0, band, fvdw, signal);
    for (let n = 0; n < total; n++) if (fvdw[n]! < f[n]!) f[n] = fvdw[n]!;
  }
  checkAbort(signal);

  const { positions, normals, indices } = surfaceNets(g, f, signal);
  return { positions, normals, indices, atomIndex: assignAtoms(atoms, positions, hash) };
}

const BRICK = 64; // nodes per brick side: larger bricks spend relatively less on their halo

export interface SurfaceChunk { positions: Float32Array; normals: Float32Array; indices: Uint32Array }

export interface StreamOptions extends SurfaceOptions {
  /** Bricks nearest this point come first (default: the grid's centre). */
  viewPoint?: Vec3;
  /** Share of the bricks for one of several workers: every `count`-th brick in order, from `index`. */
  part?: { index: number; count: number };
}

/**
 * The same surface as `generate`, computed brick by brick (BRICK nodes a side, nearest `viewPoint` first)
 * and handed to `onChunk` as each brick is done. Each brick computes the field on its nodes plus a halo
 * wide enough for every input of the field in its core (atoms within reach, and for SES the seeds within
 * probe + 2h), so core values match the whole-grid field; it meshes only the edges in its core, so
 * neighbouring bricks meet without cracks or overlaps.
 */
export function generateStreaming(kind: Kind, atoms: Atom[], opts: StreamOptions, onChunk: (chunk: SurfaceChunk) => void) {
  if (atoms.length === 0) return;
  const probe = opts.probeRadius ?? 1.4;
  const signal = opts.signal;
  const g = makeGrid(atoms, kind === "vdw" ? 0 : probe, opts);
  const { h, nx, ny, nz } = g;
  const band = 2 * h;
  let maxR = 0;
  for (const a of atoms) maxR = Math.max(maxR, a.radius);
  const inflate = kind === "vdw" ? 0 : probe;
  // SES core nodes read seeds within probe + 2h, made from nodes with all 26 neighbours present: one more
  const halo = kind === "ses" ? Math.ceil((probe + 2 * h) / h) + 2 : Math.ceil(band / h) + 1;
  // Atoms that can affect a sub-grid: within reach of its box (generous for SES's nearest-sphere and crease queries)
  const margin = maxR + probe + band + (kind === "ses" ? probe + 2 * h : 0);
  const side = BRICK * h;

  // Bricks, nearest the view point first
  const bx = Math.ceil(nx / BRICK), by = Math.ceil(ny / BRICK), bz = Math.ceil(nz / BRICK);
  const view = opts.viewPoint ?? { x: g.ox + (nx * h) / 2, y: g.oy + (ny * h) / 2, z: g.oz + (nz * h) / 2 };
  const bricks: { bi: number; bj: number; bk: number; d: number }[] = [];
  for (let bi = 0; bi < bx; bi++) for (let bj = 0; bj < by; bj++) for (let bk = 0; bk < bz; bk++) {
    const cx = g.ox + (bi + 0.5) * side, cy = g.oy + (bj + 0.5) * side, cz = g.oz + (bk + 0.5) * side;
    bricks.push({ bi, bj, bk, d: Math.hypot(cx - view.x, cy - view.y, cz - view.z) });
  }
  bricks.sort((a, b) => a.d - b.d);
  const part = opts.part ?? { index: 0, count: 1 };

  // Atoms binned by brick, to gather each sub-grid's atoms
  const binOf = (bi: number, bj: number, bk: number) => (bi * by + bj) * bz + bk;
  const bins = new Map<number, number[]>();
  atoms.forEach((a, idx) => {
    const key = binOf(
      Math.min(bx - 1, Math.max(0, Math.floor((a.x - g.ox) / side))),
      Math.min(by - 1, Math.max(0, Math.floor((a.y - g.oy) / side))),
      Math.min(bz - 1, Math.max(0, Math.floor((a.z - g.oz) / side))));
    (bins.get(key) ?? bins.set(key, []).get(key)!).push(idx);
  });
  const reach = Math.ceil((halo * h + margin) / side);

  for (let order = part.index; order < bricks.length; order += part.count) {
    const { bi, bj, bk } = bricks[order]!;
    checkAbort(signal);
    const i0 = bi * BRICK, i1 = Math.min(nx, i0 + BRICK), j0 = bj * BRICK, j1 = Math.min(ny, j0 + BRICK), k0 = bk * BRICK, k1 = Math.min(nz, k0 + BRICK);
    const si0 = Math.max(0, i0 - halo), si1 = Math.min(nx, i1 + halo), sj0 = Math.max(0, j0 - halo), sj1 = Math.min(ny, j1 + halo), sk0 = Math.max(0, k0 - halo), sk1 = Math.min(nz, k1 + halo);
    const sub: Grid = { ox: g.ox + si0 * h, oy: g.oy + sj0 * h, oz: g.oz + sk0 * h, h, nx: si1 - si0, ny: sj1 - sj0, nz: sk1 - sk0 };
    const loX = sub.ox - margin, loY = sub.oy - margin, loZ = sub.oz - margin;
    const hiX = sub.ox + (sub.nx - 1) * h + margin, hiY = sub.oy + (sub.ny - 1) * h + margin, hiZ = sub.oz + (sub.nz - 1) * h + margin;
    const local: Atom[] = [];
    for (let a = Math.max(0, bi - reach); a <= Math.min(bx - 1, bi + reach); a++)
      for (let b = Math.max(0, bj - reach); b <= Math.min(by - 1, bj + reach); b++)
        for (let c = Math.max(0, bk - reach); c <= Math.min(bz - 1, bk + reach); c++)
          for (const idx of bins.get(binOf(a, b, c)) ?? []) {
            const at = atoms[idx]!;
            if (at.x >= loX && at.x <= hiX && at.y >= loY && at.y <= hiY && at.z >= loZ && at.z <= hiZ) local.push(at);
          }
    if (local.length === 0) continue;

    const total = sub.nx * sub.ny * sub.nz;
    let f: Float32Array;
    if (kind === "ses") {
      const fsas = new Float32Array(total).fill(FAR);
      sphereField(sub, local, probe, band, fsas, signal);
      f = sesField(sub, local, probe, fsas, new AtomHash(local, 4), signal);
      const fvdw = fsas.fill(FAR);
      sphereField(sub, local, 0, band, fvdw, signal);
      for (let n = 0; n < total; n++) if (fvdw[n]! < f[n]!) f[n] = fvdw[n]!;
    } else {
      f = new Float32Array(total).fill(FAR);
      sphereField(sub, local, inflate, band, f, signal);
    }
    const mesh = surfaceNets(sub, f, signal, { i0: i0 - si0, i1: i1 - si0, j0: j0 - sj0, j1: j1 - sj0, k0: k0 - sk0, k1: k1 - sk0 });
    if (mesh.indices.length > 0) onChunk(mesh);
  }
}

export async function generateVDW(atoms: Atom[], opts: SurfaceOptions = {}): Promise<SurfaceGeometry> {
  return generate("vdw", atoms, opts);
}

export async function generateSAS(atoms: Atom[], opts: SurfaceOptions = {}): Promise<SurfaceGeometry> {
  return generate("sas", atoms, opts);
}

export async function generateSES(atoms: Atom[], opts: SurfaceOptions = {}): Promise<SurfaceGeometry> {
  return generate("ses", atoms, opts);
}

export type { Pocket, PocketOptions } from "./pockets.js";
import type { Pocket, PocketOptions } from "./pockets.js";
import type { SurfaceRequest as WorkerRequest, SurfaceResponse as WorkerResponse } from "./worker.js";

/**
 * Runs surface generation and pocket detection off the main thread (pair with the `chem-surface/worker` entry).
 * Only the latest request matters: starting a new one, or aborting via `signal`, terminates the busy
 * worker (generation is synchronous, so it can't be interrupted otherwise) and rejects with AbortError.
 */
export class SurfaceWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending: { id: number; resolve: (res: WorkerResponse & { ok: true }) => void; reject: (e: unknown) => void } | null = null;

  constructor(private createWorker: () => Worker) {}

  generate(kind: Kind, atoms: Atom[], opts: SurfaceOptions = {}): Promise<SurfaceGeometry> {
    const { signal, ...options } = opts;
    return this.request((id) => ({ id, kind, atoms, options }), signal).then((res) => {
      if (!("positions" in res)) throw new Error("unexpected response");
      return {
        positions: new Float32Array(res.positions),
        normals: new Float32Array(res.normals),
        indices: res.indices ? new Uint32Array(res.indices) : undefined,
        atomIndex: res.atomIndex ? new Uint32Array(res.atomIndex) : undefined,
      };
    });
  }

  /** Detect pockets (see findPockets), best first. */
  findPockets(atoms: Atom[], opts: PocketOptions = {}): Promise<Pocket[]> {
    const { signal, ...options } = opts;
    return this.request((id) => ({ id, kind: "pockets", atoms, options }), signal).then((res) => {
      if (!("pockets" in res)) throw new Error("unexpected response");
      return res.pockets.map((p) => ({ ...p, positions: new Float32Array(p.positions), normals: new Float32Array(p.normals), indices: new Uint32Array(p.indices), lining: new Uint32Array(p.lining) }));
    });
  }

  private request(make: (id: number) => WorkerRequest, signal?: AbortSignal): Promise<WorkerResponse & { ok: true }> {
    this.cancel();
    if (signal?.aborted) return Promise.reject(new DOMException("Surface generation aborted", "AbortError"));
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject };
      signal?.addEventListener("abort", () => { if (this.pending?.id === id) this.cancel(); }, { once: true });
      worker.postMessage(make(id));
    });
  }

  /** Abort the in-flight request, if any. */
  cancel() {
    if (!this.pending) return;
    const { reject } = this.pending;
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
    reject(new DOMException("Surface generation aborted", "AbortError"));
  }

  dispose() {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const res = ev.data;
      if (!this.pending || this.pending.id !== res.id) return;
      const { resolve, reject } = this.pending;
      this.pending = null;
      if ("chunk" in res) return; // streamed surfaces use SurfaceStreamClient
      if (!res.ok) { reject(new Error(res.error)); return; }
      resolve(res);
    };
    worker.onerror = (ev) => {
      const pending = this.pending;
      this.pending = null;
      this.worker?.terminate();
      this.worker = null;
      pending?.reject(new Error(ev.message || "Surface worker failed"));
    };
    this.worker = worker;
    return worker;
  }
}

/**
 * Streams surfaces and pockets from a pool of workers (pair with the `chem-surface/worker` entry), pieces
 * nearest the viewer first. Only the latest request matters: a new one, `cancel()` or aborting `signal`
 * terminates the busy workers and rejects with AbortError.
 */
export class SurfaceStreamClient {
  private workers: Worker[] = [];
  private nextId = 1;
  private pending: { id: number; reject: (e: unknown) => void } | null = null;

  constructor(private createWorker: () => Worker, private size = Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1))) {}

  /** Each worker computes every `size`-th brick; `onChunk` receives meshes as bricks finish. */
  generate(kind: Kind, atoms: Atom[], opts: StreamOptions, onChunk: (chunk: SurfaceChunk) => void): Promise<void> {
    const { signal, ...options } = opts;
    return this.run(signal, async (id, post) => {
      await Promise.all(Array.from({ length: this.size }, (_, index) =>
        post(index, { id, kind, stream: true, atoms, options: { ...options, part: { index, count: this.size } } }, (c) => onChunk(c))));
    });
  }

  /**
   * Detects pockets (see findPockets) in one worker, then meshes them across the pool, nearest `viewPoint`
   * first (default: best first). `onPocket` receives each with its mesh and its index in best-first order.
   */
  findPockets(atoms: Atom[], opts: PocketOptions & { viewPoint?: Vec3 }, onPocket: (index: number, pocket: Pocket) => void): Promise<void> {
    const { signal, viewPoint, ...options } = opts;
    return this.run(signal, async (id, post) => {
      const res = await post(0, { id, kind: "pockets", atoms, options: { ...options, mesh: false } });
      if (!("pockets" in res)) throw new Error("unexpected response");
      const found = res.pockets.map((p) => ({ ...p, lining: new Uint32Array(p.lining) }));
      const d2 = (c: Vec3) => (viewPoint ? (c.x - viewPoint.x) ** 2 + (c.y - viewPoint.y) ** 2 + (c.z - viewPoint.z) ** 2 : 0);
      const order = found.map((_, i) => i).sort((a, b) => d2(found[a]!.center) - d2(found[b]!.center) || a - b);
      const n = Math.min(this.size, order.length);
      await Promise.all(Array.from({ length: n }, (_, w) => {
        const sets = order.filter((_, k) => k % n === w).map((index) => ({ index, atoms: Array.from(found[index]!.lining, (i) => atoms[i]!) }));
        return post(w, { id, kind: "pocket-meshes", sets }, (c, index) => {
          if (index !== undefined) onPocket(index, { ...found[index]!, ...c });
        });
      }));
    });
  }

  /** Abort the in-flight request, if any. */
  cancel() {
    if (!this.pending) return;
    const { reject } = this.pending;
    this.pending = null;
    this.terminate(); // generation is synchronous: workers can only be stopped
    reject(new DOMException("Surface generation aborted", "AbortError"));
  }

  dispose() {
    this.cancel();
    this.terminate();
  }

  /** Runs `body` as the latest request; `post` sends a message to a pool worker and settles on its final reply. */
  private run<T>(signal: AbortSignal | undefined, body: (id: number, post: Post) => Promise<T>): Promise<T> {
    this.cancel();
    if (signal?.aborted) return Promise.reject(new DOMException("Surface generation aborted", "AbortError"));
    const id = this.nextId++;
    const live = () => this.pending?.id === id;
    return new Promise<T>((resolve, reject) => {
      this.pending = { id, reject };
      signal?.addEventListener("abort", () => { if (live()) this.cancel(); }, { once: true });
      const post: Post = (index, msg, onChunk) => new Promise((done, fail) => {
        const worker = this.workers[index] ?? (this.workers[index] = this.createWorker());
        worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
          const r = ev.data;
          if (r.id !== id || !live()) return;
          if ("chunk" in r) onChunk?.({ positions: new Float32Array(r.chunk.positions), normals: new Float32Array(r.chunk.normals), indices: new Uint32Array(r.chunk.indices) }, r.index);
          else if (!r.ok) fail(new Error(r.error));
          else done(r);
        };
        worker.onerror = (ev) => fail(new Error(ev.message || "Surface worker failed"));
        worker.postMessage(msg);
      });
      body(id, post).then(
        (v) => { if (live()) { this.pending = null; resolve(v); } },
        (e) => { if (live()) { this.pending = null; this.terminate(); reject(e); } },
      );
    });
  }

  private terminate() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }
}

type Post = (index: number, msg: WorkerRequest, onChunk?: (chunk: SurfaceChunk, index?: number) => void) => Promise<WorkerResponse & { ok: true }>;
