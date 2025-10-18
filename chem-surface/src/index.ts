export type Vec3 = { x: number; y: number; z: number };
export type Atom = Vec3 & { radius: number };

export interface SurfaceOptions {
  probeRadius?: number;
  voxelSize?: number;
  signal?: AbortSignal;
}

// (removed per-triangle gradient orientation; consistent component orientation is used instead)

function orientConsistentAndOutward(verts: Array<{ x: number; y: number; z: number }>, faces: number[], ps: ProteinSurfacePort): void {
  const triCount = Math.floor(faces.length / 3);
  if (triCount === 0) return;
  type EdgeRec = { tri: number; u: number; v: number };
  const edgeMap = new Map<string, EdgeRec[]>();
  const k = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const addE = (tri: number, u: number, v: number) => {
    const key = k(u, v);
    let arr = edgeMap.get(key);
    if (!arr) { arr = []; edgeMap.set(key, arr); }
    arr.push({ tri, u, v });
  };
  for (let t = 0; t < triCount; t++) {
    const i = t * 3;
    const a = faces[i], b = faces[i + 1], c = faces[i + 2];
    addE(t, a, b); addE(t, b, c); addE(t, c, a);
  }
  const neighbors: Array<Array<{ tri: number; sameDir: boolean }>> = Array.from({ length: triCount }, () => []);
  for (const [, arr] of edgeMap) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const e1 = arr[i], e2 = arr[j];
        const sameDir = (e1.u === e2.u && e1.v === e2.v);
        neighbors[e1.tri].push({ tri: e2.tri, sameDir });
        neighbors[e2.tri].push({ tri: e1.tri, sameDir });
      }
    }
  }
  const visited = new Uint8Array(triCount);
  const flip = new Uint8Array(triCount); // 0 keep, 1 flip
  const queue: number[] = [];
  // Helper to compute oriented normal for a triangle given current flip flag
  function triNormal(t: number) {
    const i = t * 3;
    let a = faces[i], b = faces[i + 1], c = faces[i + 2];
    if (flip[t]) { const tmp = b; b = c; c = tmp; }
    const ax = verts[a].x, ay = verts[a].y, az = verts[a].z;
    const bx = verts[b].x, by = verts[b].y, bz = verts[b].z;
    const cx = verts[c].x, cy = verts[c].y, cz = verts[c].z;
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz);
    return len > 0 ? { nx: nx / len, ny: ny / len, nz: nz / len, cx: (ax + bx + cx) / 3, cy: (ay + by + cy) / 3, cz: (az + bz + cz) / 3 } : { nx: 0, ny: 0, nz: 0, cx: (ax + bx + cx) / 3, cy: (ay + by + cy) / 3, cz: (az + bz + cz) / 3 };
  }
  const eps = 0.25;
  for (let seed = 0; seed < triCount; seed++) {
    if (visited[seed]) continue;
    const comp: number[] = [];
    visited[seed] = 1; flip[seed] = 0; queue.push(seed); comp.push(seed);
    while (queue.length) {
      const cur = queue.pop() as number;
      for (const nb of neighbors[cur]) {
        const desired = nb.sameDir ? (1 - flip[cur]) : flip[cur];
        if (!visited[nb.tri]) {
          visited[nb.tri] = 1; flip[nb.tri] = desired as 0 | 1; queue.push(nb.tri); comp.push(nb.tri);
        }
      }
    }
    // decide outward for this component
    let probeTri = seed;
    let orient = triNormal(probeTri);
    const px = orient.cx + eps * orient.nx, py = orient.cy + eps * orient.ny, pz = orient.cz + eps * orient.nz;
    const mx = orient.cx - eps * orient.nx, my = orient.cy - eps * orient.ny, mz = orient.cz - eps * orient.nz;
    const insidePlus = sampleInside(ps, px, py, pz);
    const insideMinus = sampleInside(ps, mx, my, mz);
    const compFlip = (insidePlus && !insideMinus) ? 1 : 0;
    // apply flips for this component
    for (const t of comp) { if ((flip[t] ^ compFlip) & 1) { const i = t * 3; const tmp = faces[i + 1]; faces[i + 1] = faces[i + 2]; faces[i + 2] = tmp; } }
  }
}

function orientFacesByAdjacency(faces: number[]): void {
  const triCount = Math.floor(faces.length / 3);
  if (triCount === 0) return;
  type EdgeRec = { tri: number; u: number; v: number };
  const edgeMap = new Map<string, EdgeRec[]>();
  const key = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const addEdge = (tri: number, u: number, v: number) => {
    const k = key(u, v);
    let arr = edgeMap.get(k);
    if (!arr) { arr = []; edgeMap.set(k, arr); }
    arr.push({ tri, u, v });
  };
  for (let t = 0; t < triCount; t++) {
    const i = t * 3;
    const a = faces[i], b = faces[i + 1], c = faces[i + 2];
    addEdge(t, a, b); addEdge(t, b, c); addEdge(t, c, a);
  }
  const neighbors: Array<Array<{ tri: number; sameDir: boolean }>> = Array.from({ length: triCount }, () => []);
  for (const [, arr] of edgeMap) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const e1 = arr[i], e2 = arr[j];
        const sameDir = (e1.u === e2.u && e1.v === e2.v);
        neighbors[e1.tri].push({ tri: e2.tri, sameDir });
        neighbors[e2.tri].push({ tri: e1.tri, sameDir });
      }
    }
  }
  const visited = new Uint8Array(triCount);
  const flip = new Uint8Array(triCount);
  const queue: number[] = [];
  for (let t = 0; t < triCount; t++) {
    if (visited[t]) continue;
    visited[t] = 1; flip[t] = 0; queue.push(t);
    while (queue.length) {
      const cur = queue.pop() as number;
      const wantCurFlip = flip[cur];
      for (const nb of neighbors[cur]) {
        const desired = nb.sameDir ? (1 - wantCurFlip) : wantCurFlip;
        if (!visited[nb.tri]) {
          visited[nb.tri] = 1; flip[nb.tri] = desired as 0 | 1; queue.push(nb.tri);
        }
      }
    }
  }
  // apply flips
  for (let t = 0; t < triCount; t++) {
    if (flip[t]) { const i = t * 3; const tmp = faces[i + 1]; faces[i + 1] = faces[i + 2]; faces[i + 2] = tmp; }
  }
}

function ensureOutwardBySample(verts: Array<{ x: number; y: number; z: number }>, faces: number[], ps: ProteinSurfacePort): void {
  const eps = 0.25;
  for (let t = 0; t < faces.length; t += 3) {
    const ia = faces[t], ib = faces[t + 1], ic = faces[t + 2];
    const ax = verts[ia].x, ay = verts[ia].y, az = verts[ia].z;
    const bx = verts[ib].x, by = verts[ib].y, bz = verts[ib].z;
    const cx = verts[ic].x, cy = verts[ic].y, cz = verts[ic].z;
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-8) continue;
    const ux = nx / len, uy = ny / len, uz = nz / len;
    const cxm = (ax + bx + cx) / 3, cym = (ay + by + cy) / 3, czm = (az + bz + cz) / 3;
    const px = cxm + eps * ux, py = cym + eps * uy, pz = czm + eps * uz;
    const mx = cxm - eps * ux, my = cym - eps * uy, mz = czm - eps * uz;
    const insidePlus = sampleInside(ps, px, py, pz);
    const insideMinus = sampleInside(ps, mx, my, mz);
    if (insidePlus && !insideMinus) {
      // flip all triangles globally once
      for (let k = 0; k < faces.length; k += 3) { const tmp = faces[k + 1]; faces[k + 1] = faces[k + 2]; faces[k + 2] = tmp; }
    }
    return;
  }
}

// Remove degenerate or near-zero-area triangles to avoid shading artifacts
function filterDegenerateFaces(verts: Array<{ x: number; y: number; z: number }>, faces: number[]): number[] {
  const out: number[] = [];
  for (let t = 0; t < faces.length; t += 3) {
    const ia = faces[t], ib = faces[t + 1], ic = faces[t + 2];
    if (ia === ib || ib === ic || ia === ic) continue;
    const ax = verts[ia].x, ay = verts[ia].y, az = verts[ia].z;
    const bx = verts[ib].x, by = verts[ib].y, bz = verts[ib].z;
    const cx = verts[ic].x, cy = verts[ic].y, cz = verts[ic].z;
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const area2 = nx * nx + ny * ny + nz * nz;
    if (area2 <= 1e-10) continue; // very small in grid units
    out.push(ia, ib, ic);
  }
  return out;
}

export interface SurfaceGeometry {
  positions: Float32Array;
  normals: Float32Array;
  indices?: Uint32Array;
  atomIndex?: Uint32Array;
}

// Faithful port of 3Dmol.js ProteinSurface4 pipeline (structure, rounding, voxelization, EDT),
// replacing only the final marching cubes triangulation with surface nets.

class PointGrid {
  data: Int32Array;
  width: number;
  height: number;
  constructor(length: number, width: number, height: number) {
    this.data = new Int32Array(length * width * height * 3);
    this.width = width;
    this.height = height;
  }
  set(x: number, y: number, z: number, pt: { ix: number; iy: number; iz: number }) {
    const index = ((((x * this.width) + y) * this.height) + z) * 3;
    this.data[index] = pt.ix; this.data[index + 1] = pt.iy; this.data[index + 2] = pt.iz;
  }
  get(x: number, y: number, z: number) {
    const index = ((((x * this.width) + y) * this.height) + z) * 3;
    return { ix: this.data[index], iy: this.data[index + 1], iz: this.data[index + 2] };
  }
}

// Surface type parity with 3Dmol
const SurfaceType = { VDW: 1, MS: 2, SAS: 3, SES: 4 } as const;

// Ported core with integer grid and EDT
class ProteinSurfacePort {
  readonly INOUT = 1;
  readonly ISDONE = 2;
  readonly ISBOUND = 4;

  ptranx = 0; ptrany = 0; ptranz = 0;
  probeRadius = 1.4;
  defaultScaleFactor = 2; // 0.5 Å
  scaleFactor = this.defaultScaleFactor;

  pHeight = 0; pWidth = 0; pLength = 0;
  cutRadius = 0;
  vpBits: Uint8Array | null = null;
  vpDistance: Float64Array | null = null;
  vpAtomID: Int32Array | null = null;

  pminx = 0; pminy = 0; pminz = 0;
  pmaxx = 0; pmaxy = 0; pmaxz = 0;

  // caches keyed by scaled radius key string
  depty: Record<string, Int32Array> = {};
  widxz: Record<string, number> = {};

  verts: Array<{ x: number; y: number; z: number; atomid?: number }> = [];
  faces: number[] = [];

  readonly nb = [
    new Int32Array([1, 0, 0]), new Int32Array([-1, 0, 0]), new Int32Array([0, 1, 0]), new Int32Array([0, -1, 0]), new Int32Array([0, 0, 1]), new Int32Array([0, 0, -1]),
    new Int32Array([1, 1, 0]), new Int32Array([1, -1, 0]), new Int32Array([-1, 1, 0]), new Int32Array([-1, -1, 0]),
    new Int32Array([1, 0, 1]), new Int32Array([1, 0, -1]), new Int32Array([-1, 0, 1]), new Int32Array([-1, 0, -1]),
    new Int32Array([0, 1, 1]), new Int32Array([0, 1, -1]), new Int32Array([0, -1, 1]), new Int32Array([0, -1, -1]),
    new Int32Array([1, 1, 1]), new Int32Array([1, 1, -1]), new Int32Array([1, -1, 1]), new Int32Array([-1, 1, 1]),
    new Int32Array([1, -1, -1]), new Int32Array([-1, -1, 1]), new Int32Array([-1, 1, -1]), new Int32Array([-1, -1, -1]),
  ];

  initparm(extent: number[][], btype: number, volumeEstimate: number) {
    if (volumeEstimate > 1000000) this.scaleFactor = this.defaultScaleFactor / 2;
    const margin = (1 / this.scaleFactor) * 5.5;
    this.pminx = extent[0][0]; this.pmaxx = extent[1][0];
    this.pminy = extent[0][1]; this.pmaxy = extent[1][1];
    this.pminz = extent[0][2]; this.pmaxz = extent[1][2];
    if (!btype) {
      this.pminx -= margin; this.pminy -= margin; this.pminz -= margin;
      this.pmaxx += margin; this.pmaxy += margin; this.pmaxz += margin;
    } else {
      this.pminx -= this.probeRadius + margin; this.pminy -= this.probeRadius + margin; this.pminz -= this.probeRadius + margin;
      this.pmaxx += this.probeRadius + margin; this.pmaxy += this.probeRadius + margin; this.pmaxz += this.probeRadius + margin;
    }
    this.pminx = Math.floor(this.pminx * this.scaleFactor) / this.scaleFactor;
    this.pminy = Math.floor(this.pminy * this.scaleFactor) / this.scaleFactor;
    this.pminz = Math.floor(this.pminz * this.scaleFactor) / this.scaleFactor;
    this.pmaxx = Math.ceil(this.pmaxx * this.scaleFactor) / this.scaleFactor;
    this.pmaxy = Math.ceil(this.pmaxy * this.scaleFactor) / this.scaleFactor;
    this.pmaxz = Math.ceil(this.pmaxz * this.scaleFactor) / this.scaleFactor;
    this.ptranx = -this.pminx; this.ptrany = -this.pminy; this.ptranz = -this.pminz;
    this.pLength = Math.ceil(this.scaleFactor * (this.pmaxx - this.pminx)) + 1;
    this.pWidth = Math.ceil(this.scaleFactor * (this.pmaxy - this.pminy)) + 1;
    this.pHeight = Math.ceil(this.scaleFactor * (this.pmaxz - this.pminz)) + 1;
    this.cutRadius = this.probeRadius * this.scaleFactor;
    this.vpBits = new Uint8Array(this.pLength * this.pWidth * this.pHeight);
    this.vpDistance = new Float64Array(this.pLength * this.pWidth * this.pHeight);
    this.vpAtomID = new Int32Array(this.pLength * this.pWidth * this.pHeight);
  }

  private radiusKey(r: number, btype: number) {
    const scaled = (r + (btype ? this.probeRadius : 0)) * this.scaleFactor + 0.5;
    return Math.round(scaled).toString();
  }

  private ensureRadiusTables(r: number, btype: number) {
    const key = this.radiusKey(r, btype);
    if (this.widxz[key] !== undefined) return key;
    const tr = (r + (btype ? this.probeRadius : 0)) * this.scaleFactor + 0.5;
    const sr = tr * tr;
    const w = Math.floor(tr) + 1;
    this.widxz[key] = w;
    const dep = new Int32Array(w * w);
    let idx = 0;
    for (let j = 0; j < w; j++) {
      for (let k = 0; k < w; k++) {
        const txz = j * j + k * k;
        if (txz > sr) dep[idx] = -1;
        else dep[idx] = Math.floor(Math.sqrt(sr - txz));
        idx++;
      }
    }
    this.depty[key] = dep;
    return key;
  }

  fillInit() {
    if (!this.vpBits || !this.vpDistance || !this.vpAtomID) return;
    for (let i = 0, il = this.vpBits.length; i < il; i++) {
      this.vpBits[i] = 0; this.vpDistance[i] = -1.0; this.vpAtomID[i] = -1;
    }
  }

  fillvoxels(atoms: Atom[]) {
    if (!this.vpBits || !this.vpAtomID) return;
    this.fillInit();
    for (let ai = 0; ai < atoms.length; ai++) this.fillAtom(atoms[ai], atoms, ai);
    for (let i = 0, il = this.vpBits.length; i < il; i++) if (this.vpBits[i] & this.INOUT) this.vpBits[i] |= this.ISDONE;
  }

  private fillAtom(atom: Atom, atoms: Atom[], atomIndex: number) {
    if (!this.vpBits || !this.vpAtomID) return;
    const cx = Math.floor(0.5 + this.scaleFactor * (atom.x + this.ptranx));
    const cy = Math.floor(0.5 + this.scaleFactor * (atom.y + this.ptrany));
    const cz = Math.floor(0.5 + this.scaleFactor * (atom.z + this.ptranz));
    const key = this.ensureRadiusTables(atom.radius, 1); // SAS/MS inflate path
    const w = this.widxz[key];
    const dep = this.depty[key];
    const pWH = this.pWidth * this.pHeight;
    let nind = 0;
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < w; j++) {
        if (dep[nind] !== -1) {
          for (let ii = -1; ii < 2; ii++) for (let jj = -1; jj < 2; jj++) for (let kk = -1; kk < 2; kk++) {
            if (ii !== 0 && jj !== 0 && kk !== 0) {
              const mi = ii * i, mk = kk * j;
              for (let k = 0; k <= dep[nind]; k++) {
                const mj = k * jj;
                const si = cx + mi, sj = cy + mj, sk = cz + mk;
                if (si < 0 || sj < 0 || sk < 0 || si >= this.pLength || sj >= this.pWidth || sk >= this.pHeight) continue;
                const index = si * pWH + sj * this.pHeight + sk;
                if (!(this.vpBits[index] & this.INOUT)) { this.vpBits[index] |= this.INOUT; this.vpAtomID[index] = atomIndex; }
                else {
                  const a2 = atoms[this.vpAtomID[index]]; if (a2) {
                    const ox = cx + mi - Math.floor(0.5 + this.scaleFactor * (a2.x + this.ptranx));
                    const oy = cy + mj - Math.floor(0.5 + this.scaleFactor * (a2.y + this.ptrany));
                    const oz = cz + mk - Math.floor(0.5 + this.scaleFactor * (a2.z + this.ptranz));
                    if (mi * mi + mj * mj + mk * mk < ox * ox + oy * oy + oz * oz) this.vpAtomID[index] = atomIndex;
                  }
                }
              }
            }
          }
        }
        nind++;
      }
    }
  }

  fillvoxelswaals(atoms: Atom[]) {
    if (!this.vpBits || !this.vpAtomID) return;
    for (let i = 0, il = this.vpBits.length; i < il; i++) this.vpBits[i] &= ~this.ISDONE;
    for (let ai = 0; ai < atoms.length; ai++) this.fillAtomWaals(atoms[ai], atoms, ai);
  }

  private fillAtomWaals(atom: Atom, atoms: Atom[], atomIndex: number) {
    if (!this.vpBits || !this.vpAtomID) return;
    const cx = Math.floor(0.5 + this.scaleFactor * (atom.x + this.ptranx));
    const cy = Math.floor(0.5 + this.scaleFactor * (atom.y + this.ptrany));
    const cz = Math.floor(0.5 + this.scaleFactor * (atom.z + this.ptranz));
    const key = this.ensureRadiusTables(atom.radius, 0);
    const w = this.widxz[key];
    const dep = this.depty[key];
    const pWH = this.pWidth * this.pHeight;
    let nind = 0;
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < w; j++) {
        if (dep[nind] !== -1) {
          for (let ii = -1; ii < 2; ii++) for (let jj = -1; jj < 2; jj++) for (let kk = -1; kk < 2; kk++) {
            if (ii !== 0 && jj !== 0 && kk !== 0) {
              const mi = ii * i, mk = kk * j;
              for (let k = 0; k <= dep[nind]; k++) {
                const mj = k * jj;
                const si = cx + mi, sj = cy + mj, sk = cz + mk;
                if (si < 0 || sj < 0 || sk < 0 || si >= this.pLength || sj >= this.pWidth || sk >= this.pHeight) continue;
                const index = si * pWH + sj * this.pHeight + sk;
                if (!(this.vpBits[index] & this.ISDONE)) { this.vpBits[index] |= this.ISDONE; this.vpAtomID[index] = atomIndex; }
                else {
                  const a2 = atoms[this.vpAtomID[index]]; if (a2) {
                    const ox = cx + mi - Math.floor(0.5 + this.scaleFactor * (a2.x + this.ptranx));
                    const oy = cy + mj - Math.floor(0.5 + this.scaleFactor * (a2.y + this.ptrany));
                    const oz = cz + mk - Math.floor(0.5 + this.scaleFactor * (a2.z + this.ptranz));
                    if (mi * mi + mj * mj + mk * mk < ox * ox + oy * oy + oz * oz) this.vpAtomID[index] = atomIndex;
                  }
                }
              }
            }
          }
        }
        nind++;
      }
    }
  }

  buildboundary() {
    if (!this.vpBits) return;
    const pWH = this.pWidth * this.pHeight;
    for (let i = 0; i < this.pLength; i++) {
      for (let j = 0; j < this.pHeight; j++) {
        for (let k = 0; k < this.pWidth; k++) {
          const index = i * pWH + k * this.pHeight + j;
          if (this.vpBits[index] & this.INOUT) {
            let ii = 0;
            while (ii < 26) {
              const ti = i + this.nb[ii][0], tj = j + this.nb[ii][2], tk = k + this.nb[ii][1];
              if (ti > -1 && ti < this.pLength && tk > -1 && tk < this.pWidth && tj > -1 && tj < this.pHeight && !(this.vpBits[ti * pWH + tk * this.pHeight + tj] & this.INOUT)) {
                this.vpBits[index] |= this.ISBOUND; break;
              } else ii++;
            }
          }
        }
      }
    }
  }

  fastdistancemap() {
    if (!this.vpBits || !this.vpDistance) return;
    let boundPoint = new PointGrid(this.pLength, this.pWidth, this.pHeight);
    const pWH = this.pWidth * this.pHeight;
    const cutRSq = this.cutRadius * this.cutRadius;
    let inarray: Array<{ ix: number; iy: number; iz: number }> = [];
    let outarray: Array<{ ix: number; iy: number; iz: number }> = [];
    let index = 0;
    for (let i = 0; i < this.pLength; i++) {
      for (let j = 0; j < this.pWidth; j++) {
        for (let k = 0; k < this.pHeight; k++) {
          index = i * pWH + j * this.pHeight + k;
          this.vpBits[index] &= ~this.ISDONE;
          if (this.vpBits[index] & this.INOUT) {
            if (this.vpBits[index] & this.ISBOUND) {
              const triple = { ix: i, iy: j, iz: k };
              boundPoint.set(i, j, k, triple);
              inarray.push(triple);
              this.vpDistance[index] = 0;
              this.vpBits[index] |= this.ISDONE;
              this.vpBits[index] &= ~this.ISBOUND;
            }
          }
        }
      }
    }
    do {
      outarray = this.fastoneshell(inarray, boundPoint);
      inarray = [];
      for (let i = 0, n = outarray.length; i < n; i++) {
        index = pWH * outarray[i].ix + this.pHeight * outarray[i].iy + outarray[i].iz;
        this.vpBits[index] &= ~this.ISBOUND;
        if (this.vpDistance[index] <= 1.0404 * cutRSq) {
          inarray.push({ ix: outarray[i].ix, iy: outarray[i].iy, iz: outarray[i].iz });
        }
      }
    } while (inarray.length !== 0);
    inarray = []; outarray = []; boundPoint = null as unknown as PointGrid;
    let cutsf = this.scaleFactor - 0.5; if (cutsf < 0) cutsf = 0;
    const cutoff = cutRSq - 0.50 / (0.1 + cutsf);
    for (let i = 0; i < this.pLength; i++) {
      for (let j = 0; j < this.pWidth; j++) {
        for (let k = 0; k < this.pHeight; k++) {
          index = i * pWH + j * this.pHeight + k;
          this.vpBits[index] &= ~this.ISBOUND;
          if (this.vpBits[index] & this.INOUT) {
            if (!(this.vpBits[index] & this.ISDONE) || ((this.vpBits[index] & this.ISDONE) && (this.vpDistance[index] >= cutoff))) {
              this.vpBits[index] |= this.ISBOUND;
            }
          }
        }
      }
    }
  }

  private fastoneshell(inarray: Array<{ ix: number; iy: number; iz: number }>, boundPoint: PointGrid) {
    const outarray: Array<{ ix: number; iy: number; iz: number }> = [];
    if (inarray.length === 0) return outarray;
    const pWH = this.pWidth * this.pHeight;
    for (let i = 0, n = inarray.length; i < n; i++) {
      let tx = inarray[i].ix, ty = inarray[i].iy, tz = inarray[i].iz;
      let bp = boundPoint.get(tx, ty, tz);
      for (let j = 0; j < 26; j++) {
        const tnx = tx + this.nb[j][0], tny = ty + this.nb[j][1], tnz = tz + this.nb[j][2];
        if (tnx < this.pLength && tnx > -1 && tny < this.pWidth && tny > -1 && tnz < this.pHeight && tnz > -1) {
          const index = tnx * pWH + this.pHeight * tny + tnz;
          if ((this.vpBits![index] & this.INOUT) && !(this.vpBits![index] & this.ISDONE)) {
            boundPoint.set(tnx, tny, tz + this.nb[j][2], bp);
            const dx = tnx - bp.ix, dy = tny - bp.iy, dz = tnz - bp.iz;
            const square = dx * dx + dy * dy + dz * dz;
            this.vpDistance![index] = square; this.vpBits![index] |= this.ISDONE; this.vpBits![index] |= this.ISBOUND;
            outarray.push({ ix: tnx, iy: tny, iz: tnz });
          } else if ((this.vpBits![index] & this.INOUT) && (this.vpBits![index] & this.ISDONE)) {
            const dx = tnx - bp.ix, dy = tny - bp.iy, dz = tnz - bp.iz;
            const square = dx * dx + dy * dy + dz * dz;
            if (square < this.vpDistance![index]) {
              boundPoint.set(tnx, tny, tnz, bp);
              this.vpDistance![index] = square;
              if (!(this.vpBits![index] & this.ISBOUND)) { this.vpBits![index] |= this.ISBOUND; outarray.push({ ix: tnx, iy: tny, iz: tnz }); }
            }
          }
        }
      }
    }
    return outarray;
  }

  initSurfaceField(stype: number) {
    if (!this.vpBits) return;
    for (let i = 0, lim = this.vpBits.length; i < lim; i++) {
      if (stype === SurfaceType.VDW) {
        this.vpBits[i] &= ~this.ISBOUND;
      } else if (stype === SurfaceType.SES) {
        this.vpBits[i] &= ~this.ISDONE; if (this.vpBits[i] & this.ISBOUND) this.vpBits[i] |= this.ISDONE; this.vpBits[i] &= ~this.ISBOUND;
      } else if (stype === SurfaceType.MS) {
        if ((this.vpBits[i] & this.ISBOUND) && (this.vpBits[i] & this.ISDONE)) this.vpBits[i] &= ~this.ISBOUND;
        else if ((this.vpBits[i] & this.ISBOUND) && !(this.vpBits[i] & this.ISDONE)) this.vpBits[i] |= this.ISDONE;
      } else if (stype === SurfaceType.SAS) {
        this.vpBits[i] &= ~this.ISBOUND;
      }
    }
  }
}

function orientQuadsGrid(verts: Array<{ x: number; y: number; z: number }>, faces: number[], ps: ProteinSurfacePort): void {
  for (let t = 0; t + 5 < faces.length; t += 6) {
    const ia = faces[t], ib = faces[t + 1], ic = faces[t + 2];
    const id = faces[t + 5];
    const ax = verts[ia].x, ay = verts[ia].y, az = verts[ia].z;
    const bx = verts[ib].x, by = verts[ib].y, bz = verts[ib].z;
    const cx = verts[ic].x, cy = verts[ic].y, cz = verts[ic].z;
    const dx = verts[id].x, dy = verts[id].y, dz = verts[id].z;
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const nlen = Math.hypot(nx, ny, nz);
    if (nlen < 1e-12) continue; // degenerate
    const cxm = (ax + bx + cx + dx) * 0.25;
    const cym = (ay + by + cy + dy) * 0.25;
    const czm = (az + bz + cz + dz) * 0.25;
    const g = gradientNormal(ps, cxm, cym, czm);
    const dot = nx * g.nx + ny * g.ny + nz * g.nz;
    if (dot < 0) {
      const tmp1 = faces[t + 1]; faces[t + 1] = faces[t + 2]; faces[t + 2] = tmp1;
      const tmp2 = faces[t + 4]; faces[t + 4] = faces[t + 5]; faces[t + 5] = tmp2;
    }
  }
}

// Helpers for orienting triangle winding outward using the voxel inside/outside field
function gridIndex(ps: ProteinSurfacePort, i: number, j: number, k: number): number {
  return (ps.pWidth * ps.pHeight) * i + ps.pHeight * j + k;
}

function sampleInside(ps: ProteinSurfacePort, x: number, y: number, z: number): boolean {
  // Trilinear interpolation of inside field (ISDONE) at fractional grid coordinate (x,y,z)
  const ix = Math.max(0, Math.min(ps.pLength - 2, Math.floor(x)));
  const iy = Math.max(0, Math.min(ps.pWidth - 2, Math.floor(y)));
  const iz = Math.max(0, Math.min(ps.pHeight - 2, Math.floor(z)));
  const fx = Math.min(1, Math.max(0, x - ix));
  const fy = Math.min(1, Math.max(0, y - iy));
  const fz = Math.min(1, Math.max(0, z - iz));

  const s = (i: number, j: number, k: number) => {
    const bits = ps.vpBits![gridIndex(ps, i, j, k)];
    return (bits & ps.INOUT) ? 1 : ((bits & ps.ISDONE) ? 1 : 0);
  };

  const s000 = s(ix, iy, iz);
  const s100 = s(ix + 1, iy, iz);
  const s010 = s(ix, iy + 1, iz);
  const s110 = s(ix + 1, iy + 1, iz);
  const s001 = s(ix, iy, iz + 1);
  const s101 = s(ix + 1, iy, iz + 1);
  const s011 = s(ix, iy + 1, iz + 1);
  const s111 = s(ix + 1, iy + 1, iz + 1);

  const c00 = s000 * (1 - fx) + s100 * fx;
  const c10 = s010 * (1 - fx) + s110 * fx;
  const c01 = s001 * (1 - fx) + s101 * fx;
  const c11 = s011 * (1 - fx) + s111 * fx;
  const c0 = c00 * (1 - fy) + c10 * fy;
  const c1 = c01 * (1 - fy) + c11 * fy;
  const v = c0 * (1 - fz) + c1 * fz;
  return v > 0.5;
}

function sampleField(ps: ProteinSurfacePort, x: number, y: number, z: number): number {
  const ix = Math.max(0, Math.min(ps.pLength - 2, Math.floor(x)));
  const iy = Math.max(0, Math.min(ps.pWidth - 2, Math.floor(y)));
  const iz = Math.max(0, Math.min(ps.pHeight - 2, Math.floor(z)));
  const fx = Math.min(1, Math.max(0, x - ix));
  const fy = Math.min(1, Math.max(0, y - iy));
  const fz = Math.min(1, Math.max(0, z - iz));
  const s = (i: number, j: number, k: number) => {
    const bits = ps.vpBits![gridIndex(ps, i, j, k)];
    return (bits & ps.INOUT) ? 1 : ((bits & ps.ISDONE) ? 1 : 0);
  };
  const s000 = s(ix, iy, iz);
  const s100 = s(ix + 1, iy, iz);
  const s010 = s(ix, iy + 1, iz);
  const s110 = s(ix + 1, iy + 1, iz);
  const s001 = s(ix, iy, iz + 1);
  const s101 = s(ix + 1, iy, iz + 1);
  const s011 = s(ix, iy + 1, iz + 1);
  const s111 = s(ix + 1, iy + 1, iz + 1);
  const c00 = s000 * (1 - fx) + s100 * fx;
  const c10 = s010 * (1 - fx) + s110 * fx;
  const c01 = s001 * (1 - fx) + s101 * fx;
  const c11 = s011 * (1 - fx) + s111 * fx;
  const c0 = c00 * (1 - fy) + c10 * fy;
  const c1 = c01 * (1 - fy) + c11 * fy;
  return c0 * (1 - fz) + c1 * fz;
}

function gradientNormal(ps: ProteinSurfacePort, x: number, y: number, z: number): { nx: number; ny: number; nz: number } {
  const h = 0.5; // grid units
  const fx1 = sampleField(ps, x + h, y, z);
  const fx0 = sampleField(ps, x - h, y, z);
  const fy1 = sampleField(ps, x, y + h, z);
  const fy0 = sampleField(ps, x, y - h, z);
  const fz1 = sampleField(ps, x, y, z + h);
  const fz0 = sampleField(ps, x, y, z - h);
  // Inside is 1, outside is 0, so gradient points inward; use negative for outward
  let nx = -(fx1 - fx0);
  let ny = -(fy1 - fy0);
  let nz = -(fz1 - fz0);
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  return { nx, ny, nz };
}

function orientTrianglesGrid(verts: Array<{ x: number; y: number; z: number }>, faces: number[], ps: ProteinSurfacePort): void {
  const eps = 0.25; // small step in grid units
  for (let t = 0; t < faces.length; t += 3) {
    const ia = faces[t], ib = faces[t + 1], ic = faces[t + 2];
    const ax = verts[ia].x, ay = verts[ia].y, az = verts[ia].z;
    const bx = verts[ib].x, by = verts[ib].y, bz = verts[ib].z;
    const cx = verts[ic].x, cy = verts[ic].y, cz = verts[ic].z;
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz) || 1;
    const ux = nx / len, uy = ny / len, uz = nz / len;
    const cxm = (ax + bx + cx) / 3, cym = (ay + by + cy) / 3, czm = (az + bz + cz) / 3;
    const px = cxm + eps * ux, py = cym + eps * uy, pz = czm + eps * uz;   // along normal
    const mx = cxm - eps * ux, my = cym - eps * uy, mz = czm - eps * uz;   // opposite side
    const insidePlus = sampleInside(ps, px, py, pz);
    const insideMinus = sampleInside(ps, mx, my, mz);
    // We want +eps to be outside and -eps to be inside. Flip only when reversed.
    if (insidePlus && !insideMinus) {
      faces[t + 1] = ic; faces[t + 2] = ib; // swap to flip winding
    }
  }
}

// Surface Nets triangulation on vpBits after marchingcubeinit; treat ISDONE as inside flag
function surfaceNetsFromBits(ps: ProteinSurfacePort): { verts: Array<{ x: number; y: number; z: number }>; faces: number[] } {
  const verts: Array<{ x: number; y: number; z: number }> = [];
  const faces: number[] = [];
  const vmap = new Int32Array((ps.pLength - 1) * (ps.pWidth - 1) * (ps.pHeight - 1)); vmap.fill(-1);
  const idxCell = (i: number, j: number, k: number) => i + (ps.pLength - 1) * (j + (ps.pWidth - 1) * k);
  const idxGrid = (i: number, j: number, k: number) => (ps.pWidth * ps.pHeight) * i + ps.pHeight * j + k;
  const cdx = [0, 1, 0, 1, 0, 1, 0, 1];
  const cdy = [0, 0, 1, 1, 0, 0, 1, 1];
  const cdz = [0, 0, 0, 0, 1, 1, 1, 1];
  const edges: [number, number][] = [[0,1],[1,3],[2,3],[0,2],[4,5],[5,7],[6,7],[4,6],[0,4],[1,5],[2,6],[3,7]];

  // Helpers for deterministic orientation per face
  const cornerVal = (i: number, j: number, k: number) => {
    const bits = ps.vpBits![idxGrid(i, j, k)];
    return (bits & ps.INOUT) ? 1 : ((bits & ps.ISDONE) ? 1 : 0);
  };
  const cellScore = (i: number, j: number, k: number) => {
    let s = 0;
    s += cornerVal(i, j, k);
    s += cornerVal(i + 1, j, k);
    s += cornerVal(i, j + 1, k);
    s += cornerVal(i + 1, j + 1, k);
    s += cornerVal(i, j, k + 1);
    s += cornerVal(i + 1, j, k + 1);
    s += cornerVal(i, j + 1, k + 1);
    s += cornerVal(i + 1, j + 1, k + 1);
    return s;
  };
  const pushOrientedQuad = (a: number, b: number, c: number, d: number, outx: number, outy: number, outz: number) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    const ax = verts[a].x, ay = verts[a].y, az = verts[a].z;
    const bx = verts[b].x, by = verts[b].y, bz = verts[b].z;
    const cx = verts[c].x, cy = verts[c].y, cz = verts[c].z;
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const dot = nx * outx + ny * outy + nz * outz;
    if (dot >= 0) { faces.push(a, b, c, a, c, d); }
    else { faces.push(a, c, b, a, d, c); }
  };

  let vcounter = 0;
  for (let i = 0; i < ps.pLength - 1; i++) {
    for (let j = 0; j < ps.pWidth - 1; j++) {
      for (let k = 0; k < ps.pHeight - 1; k++) {
        let mask = 0;
        const corner = new Int8Array(8);
        for (let c = 0; c < 8; c++) {
          const gi = i + cdx[c], gj = j + cdy[c], gk = k + cdz[c];
          const inside = (ps.vpBits![idxGrid(gi, gj, gk)] & ps.ISDONE) !== 0;
          corner[c] = inside ? -1 : 1;
          if (inside) mask |= (1 << c);
        }
        if (mask === 0 || mask === 0xff) continue;
        // average edge t=0.5
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (let e = 0; e < edges.length; e++) {
          const a = edges[e][0], b = edges[e][1];
          const va = corner[a], vb = corner[b];
          if ((va < 0) === (vb < 0)) continue;
          const ax = i + cdx[a], ay = j + cdy[a], az = k + cdz[a];
          const bx = i + cdx[b], by = j + cdy[b], bz = k + cdz[b];
          const t = 0.5;
          const px = ax + (bx - ax) * t;
          const py = ay + (by - ay) * t;
          const pz = az + (bz - az) * t;
          sx += px; sy += py; sz += pz; cnt++;
        }
        if (cnt === 0) continue;
        const cx = sx / cnt, cy = sy / cnt, cz = sz / cnt;
        const vidx = vcounter++;
        vmap[idxCell(i, j, k)] = vidx;
        verts.push({ x: cx, y: cy, z: cz });
      }
    }
  }

  // faces from edge changes, X/Y/Z directions

  // Per-cell face stitching: for each cell with a vertex, connect to -X, -Y, -Z neighbor cell vertices.
  for (let i = 0; i < ps.pLength - 1; i++) {
    for (let j = 0; j < ps.pWidth - 1; j++) {
      for (let k = 0; k < ps.pHeight - 1; k++) {
        const vC = vmap[idxCell(i, j, k)];
        if (vC < 0) continue;
        // -X face (neighbor i-1), stitch using Z neighbors
        if (i > 0 && k > 0) {
          const vL = vmap[idxCell(i - 1, j, k)];
          const vDL = vmap[idxCell(i - 1, j, k - 1)];
          const vD = vmap[idxCell(i, j, k - 1)];
          if (vL >= 0 && vDL >= 0 && vD >= 0) { faces.push(vC, vL, vDL, vC, vDL, vD); }
        }
        // -Y face (neighbor j-1), stitch using Z neighbors
        if (j > 0 && k > 0) {
          const vB = vmap[idxCell(i, j - 1, k)];
          const vDB = vmap[idxCell(i, j - 1, k - 1)];
          const vD = vmap[idxCell(i, j, k - 1)];
          if (vB >= 0 && vDB >= 0 && vD >= 0) { faces.push(vC, vB, vDB, vC, vDB, vD); }
        }
        // -Z face (neighbor k-1), stitch using X/Y neighbors at same k
        if (k > 0 && i > 0 && j > 0) {
          const vCL = vmap[idxCell(i - 1, j, k)];
          const vBL = vmap[idxCell(i - 1, j - 1, k)];
          const vB = vmap[idxCell(i, j - 1, k)];
          if (vCL >= 0 && vBL >= 0 && vB >= 0) { faces.push(vC, vCL, vBL, vC, vBL, vB); }
        }
      }
    }
  }

  orientQuadsGrid(verts, faces, ps);
  const cleanFaces = filterDegenerateFaces(verts, faces);
  return { verts, faces: cleanFaces };
}

function computeExtent(atoms: Atom[], inflate: number): number[][] {
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i], r = a.radius + inflate;
    if (a.x - r < minx) minx = a.x - r;
    if (a.y - r < miny) miny = a.y - r;
    if (a.z - r < minz) minz = a.z - r;
    if (a.x + r > maxx) maxx = a.x + r;
    if (a.y + r > maxy) maxy = a.y + r;
    if (a.z + r > maxz) maxz = a.z + r;
  }
  return [[minx, miny, minz], [maxx, maxy, maxz]];
}

function buildNormals(positions: Float32Array, indices: Uint32Array | undefined): Float32Array {
  const nor = new Float32Array(positions.length);
  if (!indices) return nor;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ax = positions[b] - positions[a], ay = positions[b + 1] - positions[a + 1], az = positions[b + 2] - positions[a + 2];
    const bx = positions[c] - positions[a], by = positions[c + 1] - positions[a + 1], bz = positions[c + 2] - positions[a + 2];
    const nx = ay * bz - az * by; const ny = az * bx - ax * bz; const nz = ax * by - ay * bx;
    nor[a] += nx; nor[a + 1] += ny; nor[a + 2] += nz;
    nor[b] += nx; nor[b + 1] += ny; nor[b + 2] += nz;
    nor[c] += nx; nor[c + 1] += ny; nor[c + 2] += nz;
  }
  // normalize
  for (let i = 0; i < nor.length; i += 3) {
    const nx = nor[i], ny = nor[i + 1], nz = nor[i + 2];
    const l = Math.hypot(nx, ny, nz) || 1; nor[i] = nx / l; nor[i + 1] = ny / l; nor[i + 2] = nz / l;
  }
  return nor;
}

function finalizeGeometry(ps: ProteinSurfacePort, rawVerts: Array<{ x: number; y: number; z: number }>, faces: number[], vpAtomID: Int32Array): SurfaceGeometry {
  // assign atom index using nearest grid node
  const pWH = ps.pWidth * ps.pHeight;
  const verts = rawVerts.map(v => {
    const ix = Math.max(0, Math.min(ps.pLength - 1, Math.round(v.x)));
    const iy = Math.max(0, Math.min(ps.pWidth - 1, Math.round(v.y)));
    const iz = Math.max(0, Math.min(ps.pHeight - 1, Math.round(v.z)));
    const atomid = vpAtomID[ix * pWH + iy * ps.pHeight + iz];
    return { x: v.x / ps.scaleFactor - ps.ptranx, y: v.y / ps.scaleFactor - ps.ptrany, z: v.z / ps.scaleFactor - ps.ptranz, atomid };
  });
  const positions = new Float32Array(verts.length * 3);
  const atomIndex = new Uint32Array(verts.length);
  for (let i = 0; i < verts.length; i++) {
    positions[i * 3] = verts[i].x; positions[i * 3 + 1] = verts[i].y; positions[i * 3 + 2] = verts[i].z;
    atomIndex[i] = verts[i].atomid ?? 0;
  }
  const indices = faces.length > 0 ? new Uint32Array(faces) : undefined;
  const normals = buildNormals(positions, indices);
  return { positions, normals, indices, atomIndex };
}

export async function generateVDW(atoms: Atom[], opts: SurfaceOptions = {}): Promise<SurfaceGeometry> {
  const probe = 0;
  const ps = new ProteinSurfacePort();
  if (typeof opts.voxelSize === 'number' && opts.voxelSize > 0) ps.scaleFactor = Math.max(1, Math.round(1 / opts.voxelSize));
  ps.probeRadius = opts.probeRadius ?? 1.4;
  const extent = computeExtent(atoms, probe);
  const volume = (extent[1][0]-extent[0][0])*(extent[1][1]-extent[0][1])*(extent[1][2]-extent[0][2]);
  ps.initparm(extent, 0, volume);
  ps.fillvoxelswaals(atoms);
  ps.initSurfaceField(SurfaceType.VDW);
  const { verts, faces } = surfaceNetsFromBits(ps);
  return finalizeGeometry(ps, verts, faces, ps.vpAtomID!);
}

export async function generateSAS(atoms: Atom[], opts: SurfaceOptions = {}): Promise<SurfaceGeometry> {
  const ps = new ProteinSurfacePort();
  if (typeof opts.voxelSize === 'number' && opts.voxelSize > 0) ps.scaleFactor = Math.max(1, Math.round(1 / opts.voxelSize));
  ps.probeRadius = opts.probeRadius ?? 1.4;
  const extent = computeExtent(atoms, ps.probeRadius);
  const volume = (extent[1][0]-extent[0][0])*(extent[1][1]-extent[0][1])*(extent[1][2]-extent[0][2]);
  ps.initparm(extent, 1, volume);
  ps.fillvoxels(atoms);
  ps.initSurfaceField(SurfaceType.SAS);
  const { verts, faces } = surfaceNetsFromBits(ps);
  return finalizeGeometry(ps, verts, faces, ps.vpAtomID!);
}

export async function generateSES(atoms: Atom[], opts: SurfaceOptions = {}): Promise<SurfaceGeometry> {
  const ps = new ProteinSurfacePort();
  if (typeof opts.voxelSize === 'number' && opts.voxelSize > 0) ps.scaleFactor = Math.max(1, Math.round(1 / opts.voxelSize));
  ps.probeRadius = opts.probeRadius ?? 1.4;
  const extent = computeExtent(atoms, ps.probeRadius);
  const volume = (extent[1][0]-extent[0][0])*(extent[1][1]-extent[0][1])*(extent[1][2]-extent[0][2]);
  ps.initparm(extent, 1, volume);
  // occupancy from inflated spheres
  ps.fillvoxels(atoms);
  // boundary and EDT for SES
  ps.buildboundary();
  ps.fastdistancemap();
  ps.initSurfaceField(SurfaceType.SES);
  const { verts, faces } = surfaceNetsFromBits(ps);
  return finalizeGeometry(ps, verts, faces, ps.vpAtomID!);
}
