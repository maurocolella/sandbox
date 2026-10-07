/*
 Pocket detection (LIGSITE-style buriedness on a grid); each pocket is drawn as the molecular surface of
 the residues lining it.
 - Voxels inside an atom are protein; voxels within `margin` of an atom are too close for a ligand atom.
 - Each remaining voxel counts the 7 directions (3 axes, 4 body diagonals) along which protein lies on both
   sides within `scanDistance`; voxels enclosed in at least `minBuried` directions are pocket space.
 - Connected pocket regions of at least `minVolume` are pockets, scored 0..1 from mean buriedness and size.
 - Lining atoms touch the pocket space; with `atomGroups` (e.g. residue per atom), whole groups line it.
*/
import { checkAbort, generate, type Grid, type Atom, type Vec3 } from "./index.js";

export interface PocketOptions {
  voxelSize?: number; // Å, default 0.8 (coarsened to respect maxGridPoints)
  margin?: number; // Å beyond the VDW radius that a ligand atom center can't reach, default 1.0
  scanDistance?: number; // Å, default 10
  minBuried?: number; // of 7 directions, default 5
  minVolume?: number; // Å³ of ligand-atom-center space, default 60
  maxPockets?: number; // default 20, best scores first
  maxGridPoints?: number; // default 16M
  /** Group (e.g. residue) of each atom: a pocket is lined by whole groups. */
  atomGroups?: Int32Array;
  signal?: AbortSignal;
}

export interface Pocket {
  /** Molecular surface of the lining atoms. */
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Indices (into the input atoms) of the atoms lining the pocket. */
  lining: Uint32Array;
  volume: number; // Å³
  buriedness: number; // mean fraction of directions enclosed, minBuried/7..1
  score: number; // 0..1: buriedness and size
  center: Vec3;
}

const DIRECTIONS: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1], [1, 1, -1], [1, -1, 1], [-1, 1, 1]];
const PROTEIN = 2, BLOCKED = 1;

export function findPockets(atoms: Atom[], opts: PocketOptions = {}): Pocket[] {
  const margin = opts.margin ?? 1.0, scanDistance = opts.scanDistance ?? 10, minBuried = opts.minBuried ?? 5;
  const minVolume = opts.minVolume ?? 60, maxPockets = opts.maxPockets ?? 20, signal = opts.signal;
  if (atoms.length === 0) return [];

  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (const a of atoms) {
    minx = Math.min(minx, a.x - a.radius); miny = Math.min(miny, a.y - a.radius); minz = Math.min(minz, a.z - a.radius);
    maxx = Math.max(maxx, a.x + a.radius); maxy = Math.max(maxy, a.y + a.radius); maxz = Math.max(maxz, a.z + a.radius);
  }
  const volume = (maxx - minx) * (maxy - miny) * (maxz - minz);
  const h = Math.max(opts.voxelSize ?? 0.8, Math.cbrt(volume / (opts.maxGridPoints ?? 16_000_000)));
  const g: Grid = { ox: minx - h, oy: miny - h, oz: minz - h, h, nx: Math.ceil((maxx - minx) / h) + 3, ny: Math.ceil((maxy - miny) / h) + 3, nz: Math.ceil((maxz - minz) / h) + 3 };
  const { nx, ny, nz } = g, total = nx * ny * nz, sx = ny * nz, sy = nz;

  // Protein and blocked voxels
  const state = new Uint8Array(total);
  for (let ai = 0; ai < atoms.length; ai++) {
    if ((ai & 4095) === 0) checkAbort(signal);
    const a = atoms[ai]!, r2 = a.radius * a.radius, R = a.radius + margin, R2 = R * R;
    const i0 = Math.max(0, Math.floor((a.x - R - g.ox) / h)), i1 = Math.min(nx - 1, Math.ceil((a.x + R - g.ox) / h));
    const j0 = Math.max(0, Math.floor((a.y - R - g.oy) / h)), j1 = Math.min(ny - 1, Math.ceil((a.y + R - g.oy) / h));
    const k0 = Math.max(0, Math.floor((a.z - R - g.oz) / h)), k1 = Math.min(nz - 1, Math.ceil((a.z + R - g.oz) / h));
    for (let i = i0; i <= i1; i++) {
      const dx = g.ox + i * h - a.x;
      for (let j = j0; j <= j1; j++) {
        const dy = g.oy + j * h - a.y, dxy = dx * dx + dy * dy;
        if (dxy > R2) continue;
        for (let k = k0; k <= k1; k++) {
          const dz = g.oz + k * h - a.z, d2 = dxy + dz * dz;
          const v = i * sx + j * sy + k;
          if (d2 <= r2) state[v] = PROTEIN;
          else if (d2 <= R2 && state[v] === 0) state[v] = BLOCKED;
        }
      }
    }
  }

  // Buriedness: per direction, steps since the last protein voxel going forward, then backward
  const count = new Uint8Array(total), fwd = new Uint8Array(total);
  for (const [dx, dy, dz] of DIRECTIONS) {
    checkAbort(signal);
    const maxSteps = Math.ceil(scanDistance / (h * Math.hypot(dx, dy, dz)));
    const step = dx * sx + dy * sy + dz;
    for (let pass = 0; pass < 2; pass++) {
      // Visit voxels so the previous one along the direction (forward) or the next (backward) is done first
      const s = pass === 0 ? 1 : -1;
      const ai = dx * s >= 0, aj = dy * s >= 0, ak = dz * s >= 0;
      for (let ii = 0; ii < nx; ii++) {
        const i = ai ? ii : nx - 1 - ii;
        for (let jj = 0; jj < ny; jj++) {
          const j = aj ? jj : ny - 1 - jj;
          for (let kk = 0; kk < nz; kk++) {
            const k = ak ? kk : nz - 1 - kk;
            const v = i * sx + j * sy + k;
            const pi = i - dx * s, pj = j - dy * s, pk = k - dz * s;
            let d: number;
            if (state[v] === PROTEIN) d = 0;
            else if (pi < 0 || pi >= nx || pj < 0 || pj >= ny || pk < 0 || pk >= nz) d = 255;
            else d = Math.min(255, fwd[v - step * s]! + 1); // holds this pass's value: visited first
            if (pass === 0) fwd[v] = d;
            else {
              // Backward distances overwrite forward ones once used
              if (state[v] === 0 && fwd[v]! <= maxSteps && d <= maxSteps) count[v]!++;
              fwd[v] = d;
            }
          }
        }
      }
    }
  }

  // Connected pocket regions
  const label = new Int32Array(total).fill(-1);
  const queue = new Int32Array(total);
  const regions: { voxels: number; buried: number; cx: number; cy: number; cz: number; i0: number; i1: number; j0: number; j1: number; k0: number; k1: number }[] = [];
  const isPocket = (v: number) => state[v] === 0 && count[v]! >= minBuried;
  for (let v0 = 0; v0 < total; v0++) {
    if (label[v0] !== -1 || !isPocket(v0)) continue;
    if ((regions.length & 63) === 0) checkAbort(signal);
    const id = regions.length;
    const r = { voxels: 0, buried: 0, cx: 0, cy: 0, cz: 0, i0: nx, i1: 0, j0: ny, j1: 0, k0: nz, k1: 0 };
    let head = 0, tail = 0;
    queue[tail++] = v0; label[v0] = id;
    while (head < tail) {
      const v = queue[head++]!;
      const i = Math.floor(v / sx), j = Math.floor((v % sx) / sy), k = v % sy;
      r.voxels++; r.buried += count[v]!; r.cx += i; r.cy += j; r.cz += k;
      if (i < r.i0) r.i0 = i; if (i > r.i1) r.i1 = i; if (j < r.j0) r.j0 = j; if (j > r.j1) r.j1 = j; if (k < r.k0) r.k0 = k; if (k > r.k1) r.k1 = k;
      const visit = (n: number) => { if (label[n] === -1 && isPocket(n)) { label[n] = id; queue[tail++] = n; } };
      if (i > 0) visit(v - sx); if (i < nx - 1) visit(v + sx);
      if (j > 0) visit(v - sy); if (j < ny - 1) visit(v + sy);
      if (k > 0) visit(v - 1); if (k < nz - 1) visit(v + 1);
    }
    regions.push(r);
  }

  const voxelVolume = h * h * h;
  const scored = regions
    .map((r, id) => {
      const vol = r.voxels * voxelVolume;
      const buriedness = r.buried / r.voxels / 7;
      const b = (r.buried / r.voxels - minBuried) / (7 - minBuried);
      const s = Math.min(1, Math.max(0, Math.log(vol / minVolume) / Math.log(1500 / minVolume)));
      return { r, id, vol, buriedness, score: 0.5 * b + 0.5 * s };
    })
    .filter((p) => p.vol >= minVolume)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPockets);

  // Lining atoms: within reach of a pocket voxel (VDW radius + margin + one voxel)
  const outIndex = new Map(scored.map((p, k) => [p.id, k]));
  const lining = scored.map(() => new Set<number>());
  for (let ai = 0; ai < atoms.length; ai++) {
    if ((ai & 4095) === 0) checkAbort(signal);
    const a = atoms[ai]!, R = a.radius + margin + h, R2 = R * R;
    const i0 = Math.max(0, Math.floor((a.x - R - g.ox) / h)), i1 = Math.min(nx - 1, Math.ceil((a.x + R - g.ox) / h));
    const j0 = Math.max(0, Math.floor((a.y - R - g.oy) / h)), j1 = Math.min(ny - 1, Math.ceil((a.y + R - g.oy) / h));
    const k0 = Math.max(0, Math.floor((a.z - R - g.oz) / h)), k1 = Math.min(nz - 1, Math.ceil((a.z + R - g.oz) / h));
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) {
      const l = label[i * sx + j * sy + k]!;
      if (l < 0) continue;
      const out = outIndex.get(l);
      if (out === undefined) continue;
      const dx = g.ox + i * h - a.x, dy = g.oy + j * h - a.y, dz = g.oz + k * h - a.z;
      if (dx * dx + dy * dy + dz * dz <= R2) lining[out]!.add(ai);
    }
  }
  // Whole groups (residues) line the pocket
  const groups = opts.atomGroups;
  if (groups) {
    const members = new Map<number, number[]>();
    for (let ai = 0; ai < atoms.length; ai++) { const gi = groups[ai]!; const m = members.get(gi); if (m) m.push(ai); else members.set(gi, [ai]); }
    for (const set of lining) for (const ai of [...set]) for (const other of members.get(groups[ai]!) ?? []) set.add(other);
  }

  return scored.map(({ vol, r, buriedness, score }, k) => {
    checkAbort(signal);
    const idx = Uint32Array.from([...lining[k]!].sort((a, b) => a - b));
    const { positions, normals, indices } = generate("ses", Array.from(idx, (i) => atoms[i]!), { probeRadius: 1.4, voxelSize: 0.5, signal });
    return {
      positions, normals, indices: indices ?? new Uint32Array(0), lining: idx, volume: vol, buriedness, score,
      center: { x: g.ox + (r.cx / r.voxels) * h, y: g.oy + (r.cy / r.voxels) * h, z: g.oz + (r.cz / r.voxels) * h },
    };
  });
}
