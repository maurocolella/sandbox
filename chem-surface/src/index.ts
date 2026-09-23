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

interface Grid {
  ox: number; oy: number; oz: number; // origin (Å)
  h: number; // spacing (Å)
  nx: number; ny: number; nz: number;
}


function checkAbort(signal?: AbortSignal) {
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
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i]!, Ri = a.radius + probe;
    for (const j of nbrs[i]!) {
      if (j < i) continue;
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
        out[n] = probe - Math.sqrt(best);
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
function surfaceNets(g: Grid, f: Float32Array, signal?: AbortSignal) {
  const { ox, oy, oz, h, nx, ny, nz } = g;
  const cny = ny - 1, cnz = nz - 1;
  const cellVert = new Int32Array((nx - 1) * cny * cnz).fill(-1);
  const pos = new FloatBuilder(1 << 16);
  const nrm = new FloatBuilder(1 << 16);
  const idx = new IndexBuilder(1 << 17);
  const v = new Float64Array(8);

  for (let i = 0; i < nx - 1; i++) {
    checkAbort(signal);
    for (let j = 0; j < ny - 1; j++) for (let k = 0; k < nz - 1; k++) {
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
  for (let i = 1; i < nx - 1; i++) {
    checkAbort(signal);
    for (let j = 1; j < ny - 1; j++) for (let k = 1; k < nz - 1; k++) {
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

function generate(kind: Kind, atoms: Atom[], opts: SurfaceOptions): SurfaceGeometry {
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

export async function generateVDW(atoms: Atom[], opts: SurfaceOptions = {}): Promise<SurfaceGeometry> {
  return generate("vdw", atoms, opts);
}

export async function generateSAS(atoms: Atom[], opts: SurfaceOptions = {}): Promise<SurfaceGeometry> {
  return generate("sas", atoms, opts);
}

export async function generateSES(atoms: Atom[], opts: SurfaceOptions = {}): Promise<SurfaceGeometry> {
  return generate("ses", atoms, opts);
}

type WorkerRequest = { id: number; kind: Kind; atoms: Atom[]; options?: Omit<SurfaceOptions, "signal"> };
type WorkerResponse =
  | { id: number; ok: true; positions: ArrayBuffer; normals: ArrayBuffer; indices?: ArrayBuffer; atomIndex?: ArrayBuffer }
  | { id: number; ok: false; error: string };

/**
 * Runs surface generation off the main thread (pair with the `chem-surface/worker` entry).
 * Only the latest request matters: starting a new one, or aborting via `signal`, terminates the busy
 * worker (generation is synchronous, so it can't be interrupted otherwise) and rejects with AbortError.
 */
export class SurfaceWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending: { id: number; resolve: (g: SurfaceGeometry) => void; reject: (e: unknown) => void } | null = null;

  constructor(private createWorker: () => Worker) {}

  generate(kind: Kind, atoms: Atom[], opts: SurfaceOptions = {}): Promise<SurfaceGeometry> {
    this.cancel();
    const { signal, ...options } = opts;
    if (signal?.aborted) return Promise.reject(new DOMException("Surface generation aborted", "AbortError"));
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<SurfaceGeometry>((resolve, reject) => {
      this.pending = { id, resolve, reject };
      signal?.addEventListener("abort", () => { if (this.pending?.id === id) this.cancel(); }, { once: true });
      worker.postMessage({ id, kind, atoms, options } satisfies WorkerRequest);
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
      if (!res.ok) { reject(new Error(res.error)); return; }
      resolve({
        positions: new Float32Array(res.positions),
        normals: new Float32Array(res.normals),
        indices: res.indices ? new Uint32Array(res.indices) : undefined,
        atomIndex: res.atomIndex ? new Uint32Array(res.atomIndex) : undefined,
      });
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
