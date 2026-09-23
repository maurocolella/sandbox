import * as THREE from "three";
import type { MolScene } from "../../types/molScene.js";

// PyMOL auto-color cycle (carbon, cyan, lightmagenta, yellow, salmon, hydrogen, slate, orange), used per chain
export const PYMOL_CHAIN_COLORS = [
  0x33ff33, 0x00ffff, 0xff33cc, 0xffff00, 0xff9999, 0xe6e6e6, 0x8080ff, 0xff8000,
] as const;

export interface RibbonOptions {
  radius?: number; // tube radius
  tubularSegmentsPerPoint?: number; // segments per backbone point, default 4
  radialSegments?: number; // tube radial segments, default 12
  color?: number; // material color, default 0xffffff
  materialKind?: "basic" | "lambert" | "standard";
}

/**
 * Build a ribbon/cartoon-like tube along the parsed backbone polyline.
 * This uses TubeGeometry over each backbone segment to create a smooth path.
 */
export function makeRibbonMesh(scene: MolScene, opts: RibbonOptions = {}): THREE.Group | null {
  if (!scene.backbone) return null;

  const positions = scene.backbone.positions;
  const segments = scene.backbone.segments;
  const residueOfPoint = scene.backbone.residueOfPoint;

  const radius = opts.radius ?? 0.4;
  const radialSegments = Math.max(3, opts.radialSegments ?? 12);
  const tubularPerPoint = Math.max(1, opts.tubularSegmentsPerPoint ?? 4);

  const materialKind = opts.materialKind ?? "standard";
  const group = new THREE.Group();
  const tmp = new THREE.Vector3();

  // Build residue->chain map once
  const residueCount = scene.tables?.residues?.length ?? 0;
  const residueToChain = new Int32Array(Math.max(1, residueCount)).fill(-1);
  if (scene.atoms.residueIndex && scene.atoms.chainIndex) {
    const N = scene.atoms.count;
    for (let i = 0; i < N; i++) {
      const ri = scene.atoms.residueIndex![i]!;
      if (ri >= 0 && ri < residueToChain.length && residueToChain[ri] === -1) {
        residueToChain[ri] = scene.atoms.chainIndex![i]!;
      }
    }
  }

  const matCache = new Map<number, THREE.Material>();
  const makeMaterial = (hex: number): THREE.Material => {
    if (materialKind === "basic") return new THREE.MeshBasicMaterial({ color: hex });
    if (materialKind === "lambert") return new THREE.MeshLambertMaterial({ color: hex });
    return new THREE.MeshStandardMaterial({ color: hex, metalness: 0.08, roughness: 0.72 });
  };
  const getMaterialForChain = (chainIdx: number): THREE.Material => {
    const key = chainIdx >= 0 ? chainIdx : 0;
    let m = matCache.get(key);
    if (!m) {
      const hex = PYMOL_CHAIN_COLORS[key % PYMOL_CHAIN_COLORS.length]!;
      m = makeMaterial(hex);
      matCache.set(key, m);
    }
    return m;
  };

  for (let s = 0; s < segments.length; s += 2) {
    const start = segments[s];
    const end = segments[s + 1];
    const count = end - start;
    if (count < 2) continue;

    const pts: THREE.Vector3[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const idx = (start + i) * 3;
      tmp.set(positions[idx], positions[idx + 1], positions[idx + 2]);
      pts[i] = tmp.clone();
    }
    const curve = new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.5);
    const tubularSegments = Math.max(8, count * tubularPerPoint);
    const geom = new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, false);
    // Determine chain index for this segment via first residueOfPoint
    const firstResidue = residueOfPoint ? residueOfPoint[start] : -1;
    const chainIdx = firstResidue >= 0 ? residueToChain[firstResidue] : -1;
    const mat = getMaterialForChain(chainIdx);
    const mesh = new THREE.Mesh(geom, mat);
    group.add(mesh);
  }

  return group;
}

export interface FlatRibbonOptions {
  samplesPerResidue?: number; // spline samples between consecutive residues (PyMOL cartoon_sampling), default 7
  profileSegments?: number; // vertices around the cross-section, default 16
  loopRadius?: number; // PyMOL cartoon_loop_radius, default 0.2
  helixHalfWidth?: number; // PyMOL cartoon_oval_length, default 1.35
  helixHalfThickness?: number; // PyMOL cartoon_oval_width, default 0.25
  sheetHalfWidth?: number; // default 1.0 (PyMOL cartoon_rect_length 1.4 · cos45)
  sheetHalfThickness?: number; // default 0.28 (PyMOL cartoon_rect_width 0.4 · cos45)
  arrowHalfWidth?: number; // half-width at the arrowhead base, default 1.5
  materialKind?: "basic" | "lambert" | "standard";
}

// Cross-section: superellipse |x/hw|^p + |y/hh|^p = 1 in the (normal, binormal) plane.
// p = 2 gives the loop tube and helix oval; a large p gives the (slightly rounded) sheet rectangle.
// Interpolating (hw, hh, p) morphs smoothly between secondary-structure types.
interface Profile { hw: number; hh: number; p: number }
const SHEET_POWER = 10;

const KIND_LOOP = 0, KIND_HELIX = 1, KIND_SHEET = 2;

class FloatBuilder {
  data: Float32Array;
  length = 0;
  constructor(capacity: number) { this.data = new Float32Array(Math.max(16, capacity)); }
  push3(x: number, y: number, z: number) {
    if (this.length + 3 > this.data.length) { const d = new Float32Array(this.data.length * 2); d.set(this.data); this.data = d; }
    this.data[this.length++] = x; this.data[this.length++] = y; this.data[this.length++] = z;
  }
  view() { return this.data.subarray(0, this.length); }
}

class IndexBuilder {
  data: Uint32Array;
  length = 0;
  constructor(capacity: number) { this.data = new Uint32Array(Math.max(16, capacity)); }
  push3(a: number, b: number, c: number) {
    if (this.length + 3 > this.data.length) { const d = new Uint32Array(this.data.length * 2); d.set(this.data); this.data = d; }
    this.data[this.length++] = a; this.data[this.length++] = b; this.data[this.length++] = c;
  }
  view() { return this.data.subarray(0, this.length); }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (t: number) => t * t * (3 - 2 * t);

/**
 * PyMOL-style cartoon: loops as thin tubes, helices as oval ribbons, sheets as flat rectangles ending
 * in arrowheads. The ribbon plane follows the peptide planes (CA->O vectors from the parser), so helices
 * spiral with the backbone and strands lie flat; sheets are smoothed like PyMOL's cartoon_flat_sheets.
 * All chains are merged into one mesh with per-vertex chain colors (single draw call).
 */
export function makeFlatRibbonMesh(scene: MolScene, opts: FlatRibbonOptions = {}): THREE.Group | null {
  if (!scene.backbone) return null;

  const positions = scene.backbone.positions;
  const segments = scene.backbone.segments;
  const residueOfPoint = scene.backbone.residueOfPoint;
  const orientation = scene.backbone.orientation;

  const S = Math.max(2, Math.round(opts.samplesPerResidue ?? 7));
  const K = Math.max(8, Math.round(opts.profileSegments ?? 16));
  const loop: Profile = { hw: opts.loopRadius ?? 0.2, hh: opts.loopRadius ?? 0.2, p: 2 };
  const helix: Profile = { hw: opts.helixHalfWidth ?? 1.35, hh: opts.helixHalfThickness ?? 0.25, p: 2 };
  const sheet: Profile = { hw: opts.sheetHalfWidth ?? 1.0, hh: opts.sheetHalfThickness ?? 0.28, p: SHEET_POWER };
  const arrowHalfWidth = opts.arrowHalfWidth ?? 1.5;
  const profileOf = (kind: number) => (kind === KIND_HELIX ? helix : kind === KIND_SHEET ? sheet : loop);

  // Residue -> chain, secondary kind, and span id (so adjacent spans stay distinct)
  const residueCount = scene.tables?.residues?.length ?? 0;
  const residueToChain = new Int32Array(Math.max(1, residueCount)).fill(-1);
  const tableResidues = scene.tables?.residues;
  if (tableResidues) {
    for (let ri = 0; ri < residueCount; ri++) residueToChain[ri] = tableResidues[ri]!.chain ?? -1;
  }
  if (scene.atoms.residueIndex && scene.atoms.chainIndex) {
    for (let i = 0; i < scene.atoms.count; i++) {
      const ri = scene.atoms.residueIndex[i]!;
      if (ri < residueToChain.length && residueToChain[ri] === -1) residueToChain[ri] = scene.atoms.chainIndex[i]!;
    }
  }
  const kindByResidue = new Uint8Array(Math.max(1, residueCount));
  const spanByResidue = new Int32Array(Math.max(1, residueCount)).fill(-1);
  scene.tables?.secondary?.forEach((span, si) => {
    const kind = span.kind === "helix" ? KIND_HELIX : KIND_SHEET;
    for (let ri = span.startResidue; ri <= span.endResidue && ri < residueCount; ri++) {
      kindByResidue[ri] = kind;
      spanByResidue[ri] = si;
    }
  });

  const pointCount = positions.length / 3;
  const estVerts = pointCount * (S + 1) * K;
  const pos = new FloatBuilder(estVerts * 3);
  const nrm = new FloatBuilder(estVerts * 3);
  const col = new FloatBuilder(estVerts * 3);
  const idx = new IndexBuilder(estVerts * 6);
  const color = new THREE.Color();

  // Profile unit directions, shared by every ring
  const cosT = new Float32Array(K), sinT = new Float32Array(K);
  for (let k = 0; k < K; k++) { cosT[k] = Math.cos((2 * Math.PI * k) / K); sinT[k] = Math.sin((2 * Math.PI * k) / K); }

  let prevRing = -1; // first vertex of the previous ring, or -1 when the strip is broken
  // Emit one ring of K vertices. flatNormal: when set, all vertices use this normal (caps/back faces).
  const emitRing = (
    px: number, py: number, pz: number,
    n: Float64Array, b: Float64Array, prof: Profile,
    connect: boolean, flatNormal: Float64Array | null
  ): number => {
    const base = pos.length / 3;
    const e = 2 / prof.p;
    for (let k = 0; k < K; k++) {
      const c = cosT[k]!, s = sinT[k]!;
      const ux = Math.sign(c) * Math.pow(Math.abs(c), e);
      const uy = Math.sign(s) * Math.pow(Math.abs(s), e);
      const x = ux * prof.hw, y = uy * prof.hh;
      pos.push3(px + n[0]! * x + b[0]! * y, py + n[1]! * x + b[1]! * y, pz + n[2]! * x + b[2]! * y);
      if (flatNormal) {
        nrm.push3(flatNormal[0]!, flatNormal[1]!, flatNormal[2]!);
      } else {
        // Gradient of the superellipse gives the outward normal
        const gx = Math.sign(ux) * Math.pow(Math.abs(ux), prof.p - 1) / prof.hw;
        const gy = Math.sign(uy) * Math.pow(Math.abs(uy), prof.p - 1) / prof.hh;
        const nx = n[0]! * gx + b[0]! * gy, ny = n[1]! * gx + b[1]! * gy, nz = n[2]! * gx + b[2]! * gy;
        const len = Math.hypot(nx, ny, nz) || 1;
        nrm.push3(nx / len, ny / len, nz / len);
      }
      col.push3(color.r, color.g, color.b);
    }
    if (connect && prevRing >= 0) {
      for (let k = 0; k < K; k++) {
        const k1 = (k + 1) % K;
        const a = prevRing + k, bb = prevRing + k1, c = base + k, d = base + k1;
        idx.push3(a, bb, c);
        idx.push3(bb, d, c);
      }
    }
    prevRing = base;
    return base;
  };

  // Flat cap closing a ring; facing = +1 caps a strip end (normal +t), -1 a strip start (normal -t)
  const emitCap = (
    px: number, py: number, pz: number,
    n: Float64Array, b: Float64Array, t: Float64Array, prof: Profile, facing: 1 | -1
  ) => {
    const fn = new Float64Array([t[0]! * facing, t[1]! * facing, t[2]! * facing]);
    const saved = prevRing;
    const ring = emitRing(px, py, pz, n, b, prof, false, fn);
    const center = pos.length / 3;
    pos.push3(px, py, pz);
    nrm.push3(fn[0]!, fn[1]!, fn[2]!);
    col.push3(color.r, color.g, color.b);
    for (let k = 0; k < K; k++) {
      const k1 = (k + 1) % K;
      if (facing === 1) idx.push3(center, ring + k, ring + k1);
      else idx.push3(center, ring + k1, ring + k);
    }
    prevRing = saved;
  };

  // Scratch frame vectors
  const t = new Float64Array(3), n = new Float64Array(3), b = new Float64Array(3);

  for (let s = 0; s < segments.length; s += 2) {
    const start = segments[s]!;
    const count = segments[s + 1]! - start;
    if (count < 2) continue;

    const res = new Int32Array(count);
    const kind = new Uint8Array(count);
    const span = new Int32Array(count);
    const P = new Float64Array(count * 3);
    for (let i = 0; i < count; i++) {
      const ri = residueOfPoint ? residueOfPoint[start + i]! : -1;
      res[i] = ri;
      kind[i] = ri >= 0 && ri < residueCount ? kindByResidue[ri]! : KIND_LOOP;
      span[i] = ri >= 0 && ri < residueCount ? spanByResidue[ri]! : -1;
      P[i * 3] = positions[(start + i) * 3]!;
      P[i * 3 + 1] = positions[(start + i) * 3 + 1]!;
      P[i * 3 + 2] = positions[(start + i) * 3 + 2]!;
    }
    const chainIdx = res[0]! >= 0 ? residueToChain[res[0]!]! : -1;
    color.setHex(PYMOL_CHAIN_COLORS[(chainIdx >= 0 ? chainIdx : 0) % PYMOL_CHAIN_COLORS.length]!);

    // Tangent at each CA (central difference)
    const T = new Float64Array(count * 3);
    for (let i = 0; i < count; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(count - 1, i + 1);
      const x = P[i1 * 3]! - P[i0 * 3]!, y = P[i1 * 3 + 1]! - P[i0 * 3 + 1]!, z = P[i1 * 3 + 2]! - P[i0 * 3 + 2]!;
      const len = Math.hypot(x, y, z) || 1;
      T[i * 3] = x / len; T[i * 3 + 1] = y / len; T[i * 3 + 2] = z / len;
    }

    // Guide normal per residue: carbonyl direction orthogonalised against the tangent.
    // Without an O atom, fall back to (CA bisector x tangent), which lies near the helix axis in helices.
    const N = new Float64Array(count * 3);
    for (let i = 0; i < count; i++) {
      let x = 0, y = 0, z = 0;
      if (orientation) { x = orientation[(start + i) * 3]!; y = orientation[(start + i) * 3 + 1]!; z = orientation[(start + i) * 3 + 2]!; }
      if (x * x + y * y + z * z < 1e-6 && i > 0 && i < count - 1) {
        const bx = P[(i - 1) * 3]! + P[(i + 1) * 3]! - 2 * P[i * 3]!;
        const by = P[(i - 1) * 3 + 1]! + P[(i + 1) * 3 + 1]! - 2 * P[i * 3 + 1]!;
        const bz = P[(i - 1) * 3 + 2]! + P[(i + 1) * 3 + 2]! - 2 * P[i * 3 + 2]!;
        x = by * T[i * 3 + 2]! - bz * T[i * 3 + 1]!;
        y = bz * T[i * 3]! - bx * T[i * 3 + 2]!;
        z = bx * T[i * 3 + 1]! - by * T[i * 3]!;
      }
      const d = x * T[i * 3]! + y * T[i * 3 + 1]! + z * T[i * 3 + 2]!;
      x -= d * T[i * 3]!; y -= d * T[i * 3 + 1]!; z -= d * T[i * 3 + 2]!;
      const len = Math.hypot(x, y, z);
      if (len > 1e-6) { N[i * 3] = x / len; N[i * 3 + 1] = y / len; N[i * 3 + 2] = z / len; }
    }
    // Fill residues without a usable normal from their neighbours, then remove 180° flips
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < count; i++) {
        if (N[i * 3]! !== 0 || N[i * 3 + 1]! !== 0 || N[i * 3 + 2]! !== 0) continue;
        const j = pass === 0 ? i - 1 : i + 1;
        if (j >= 0 && j < count) { N[i * 3] = N[j * 3]!; N[i * 3 + 1] = N[j * 3 + 1]!; N[i * 3 + 2] = N[j * 3 + 2]!; }
      }
    }
    // Still unset (short segment without O atoms): any vector perpendicular to the tangent
    for (let i = 0; i < count; i++) {
      if (N[i * 3]! !== 0 || N[i * 3 + 1]! !== 0 || N[i * 3 + 2]! !== 0) continue;
      const tx = T[i * 3]!, ty = T[i * 3 + 1]!, tz = T[i * 3 + 2]!;
      const ax = Math.abs(tx) < 0.9 ? 1 : 0, ay = 1 - ax;
      const x = -tz * ay, y = tz * ax, z = tx * ay - ty * ax; // t x (ax, ay, 0)
      const len = Math.hypot(x, y, z) || 1;
      N[i * 3] = x / len; N[i * 3 + 1] = y / len; N[i * 3 + 2] = z / len;
    }
    for (let i = 1; i < count; i++) {
      const d = N[i * 3]! * N[(i - 1) * 3]! + N[i * 3 + 1]! * N[(i - 1) * 3 + 1]! + N[i * 3 + 2]! * N[(i - 1) * 3 + 2]!;
      if (d < 0) { N[i * 3] = -N[i * 3]!; N[i * 3 + 1] = -N[i * 3 + 1]!; N[i * 3 + 2] = -N[i * 3 + 2]!; }
    }

    // Flat sheets: smooth strand positions and normals to remove the CA zigzag
    const inSameSheet = (i: number, j: number) => j >= 0 && j < count && kind[j] === KIND_SHEET && span[j] === span[i];
    for (let pass = 0; pass < 2; pass++) {
      const P2 = P.slice(), N2 = N.slice();
      for (let i = 0; i < count; i++) {
        if (kind[i] !== KIND_SHEET || !inSameSheet(i, i - 1) || !inSameSheet(i, i + 1)) continue;
        for (let c = 0; c < 3; c++) {
          P2[i * 3 + c] = 0.25 * P[(i - 1) * 3 + c]! + 0.5 * P[i * 3 + c]! + 0.25 * P[(i + 1) * 3 + c]!;
          N2[i * 3 + c] = 0.25 * N[(i - 1) * 3 + c]! + 0.5 * N[i * 3 + c]! + 0.25 * N[(i + 1) * 3 + c]!;
        }
      }
      P.set(P2); N.set(N2);
    }

    // Arrowheads span the last residue interval of each strand with at least two residues
    const isArrowStart = (i: number) =>
      kind[i] === KIND_SHEET && inSameSheet(i, i + 1) && !inSameSheet(i, i + 2);

    // Catmull-Rom point/derivative on interval i at f, with mirrored end control points
    const ctrl = (j: number, c: number) => {
      if (j < 0) return 2 * P[c]! - P[3 + c]!;
      if (j >= count) return 2 * P[(count - 1) * 3 + c]! - P[(count - 2) * 3 + c]!;
      return P[j * 3 + c]!;
    };
    const out = new Float64Array(3);
    const sample = (i: number, f: number) => {
      const f2 = f * f, f3 = f2 * f;
      for (let c = 0; c < 3; c++) {
        const p0 = ctrl(i - 1, c), p1 = ctrl(i, c), p2 = ctrl(i + 1, c), p3 = ctrl(i + 2, c);
        out[c] = 0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 + (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
        t[c] = 0.5 * ((-p0 + p2) + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * f + 3 * (-p0 + 3 * p1 - 3 * p2 + p3) * f2);
      }
      let len = Math.hypot(t[0]!, t[1]!, t[2]!) || 1;
      t[0] = t[0]! / len; t[1] = t[1]! / len; t[2] = t[2]! / len;
      const j = Math.min(i + 1, count - 1);
      for (let c = 0; c < 3; c++) n[c] = lerp(N[i * 3 + c]!, N[j * 3 + c]!, f);
      const d = n[0]! * t[0]! + n[1]! * t[1]! + n[2]! * t[2]!;
      n[0] = n[0]! - d * t[0]!; n[1] = n[1]! - d * t[1]!; n[2] = n[2]! - d * t[2]!;
      len = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
      n[0] = n[0]! / len; n[1] = n[1]! / len; n[2] = n[2]! / len;
      b[0] = t[1]! * n[2]! - t[2]! * n[1]!;
      b[1] = t[2]! * n[0]! - t[0]! * n[2]!;
      b[2] = t[0]! * n[1]! - t[1]! * n[0]!;
    };

    // Cross-section at interval i, fraction f
    const prof: Profile = { hw: 0, hh: 0, p: 2 };
    const profileAt = (i: number, f: number) => {
      if (isArrowStart(i)) {
        prof.hw = lerp(arrowHalfWidth, loop.hw, f); prof.hh = sheet.hh; prof.p = sheet.p;
        return prof;
      }
      const a = i > 0 && isArrowStart(i - 1) ? { hw: loop.hw, hh: sheet.hh, p: sheet.p } : profileOf(kind[i]!);
      const z = profileOf(kind[Math.min(i + 1, count - 1)]!);
      const w = a === z ? 0 : smoothstep(f);
      prof.hw = lerp(a.hw, z.hw, w); prof.hh = lerp(a.hh, z.hh, w); prof.p = lerp(a.p, z.p, w);
      return prof;
    };

    prevRing = -1;
    for (let i = 0; i < count - 1; i++) {
      if (isArrowStart(i) && prevRing >= 0) {
        // Close the strand body at the arrow base, then the arrowhead's back face (normal -t)
        sample(i, 0);
        const body = profileOf(KIND_SHEET);
        emitRing(out[0]!, out[1]!, out[2]!, n, b, body, true, null);
        const back = new Float64Array([-t[0]!, -t[1]!, -t[2]!]);
        const inner = emitRing(out[0]!, out[1]!, out[2]!, n, b, body, false, back);
        const outer = emitRing(out[0]!, out[1]!, out[2]!, n, b, profileAt(i, 0), false, back);
        for (let k = 0; k < K; k++) {
          const k1 = (k + 1) % K;
          idx.push3(inner + k, inner + k1, outer + k);
          idx.push3(inner + k1, outer + k1, outer + k);
        }
        prevRing = -1;
      }
      for (let j = 0; j < S; j++) {
        const f = j / S;
        sample(i, f);
        if (i === 0 && j === 0) emitCap(out[0]!, out[1]!, out[2]!, n, b, t, profileAt(i, f), -1);
        emitRing(out[0]!, out[1]!, out[2]!, n, b, profileAt(i, f), true, null);
      }
    }
    // Final ring at the last residue, then the end cap
    sample(count - 2, 1);
    const last = profileAt(count - 2, 1);
    emitRing(out[0]!, out[1]!, out[2]!, n, b, last, true, null);
    emitCap(out[0]!, out[1]!, out[2]!, n, b, t, last, 1);
  }

  if (pos.length === 0) return null;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(pos.view().slice(), 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(nrm.view().slice(), 3));
  geom.setAttribute("color", new THREE.BufferAttribute(col.view().slice(), 3));
  geom.setIndex(new THREE.BufferAttribute(idx.view().slice(), 1));
  geom.computeBoundingSphere();

  const materialKind = opts.materialKind ?? "standard";
  const mat: THREE.Material = materialKind === "basic"
    ? new THREE.MeshBasicMaterial({ vertexColors: true })
    : materialKind === "lambert"
    ? new THREE.MeshLambertMaterial({ vertexColors: true })
    : new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.0, roughness: 0.55 });

  const group = new THREE.Group();
  group.add(new THREE.Mesh(geom, mat));
  return group;
}
