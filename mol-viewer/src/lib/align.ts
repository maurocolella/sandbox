/*
 Title: align
 Description: Rigid placement of a swapped-in molecule onto the original ligand's pose:
 - Starts: centroid on the original's, principal axes on the original's, in the 4 proper sign combinations.
 - Score: Gaussian shape overlap with the original (a Tanimoto-like ratio, 1 = identical volume) minus a
   penalty for heavy atoms closer than CLASH_SOFT to nearby polymer atoms.
 - Each start is refined by a seeded rigid hill-climb (random small rotations and shifts, shrinking).
 The result is a pose hypothesis: it assumes the original's binding mode.
*/
import type { MolScene } from "pdb-parser";
import { ligandAtoms, type LigandRef } from "mol-renderer";

type V = [number, number, number];
type M = [number, number, number, number, number, number, number, number, number]; // row-major 3x3

const ALPHA = 0.8; // Gaussian width (1/Å²) of the shape overlap
const CLASH_SOFT = 3.0; // Å: heavy-atom contacts closer than this are penalised
const CLASH_HARD = 2.5; // Å: and counted as clashes
const CLASH_WEIGHT = 0.15;
const NEIGHBOURHOOD = 14; // Å around the original ligand: polymer atoms that can clash
const STEPS = 300;
const WATER = new Set(["HOH", "WAT", "DOD", "H2O"]);

export interface Alignment {
  positions: Float32Array;
  shape: number; // 0..1 overlap with the original ligand
  clashes: number; // heavy-atom pairs closer than CLASH_HARD
}

const mul = (a: M, b: M): M => {
  const o = new Array(9).fill(0) as M;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k]! * b[k * 3 + j]!;
  return o;
};
const transpose = (a: M): M => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
const apply = (r: M, v: V): V => [r[0] * v[0] + r[1] * v[1] + r[2] * v[2], r[3] * v[0] + r[4] * v[1] + r[5] * v[2], r[6] * v[0] + r[7] * v[1] + r[8] * v[2]];

/** Rotation about a unit axis. */
function axisAngle(ax: V, t: number): M {
  const [x, y, z] = ax, c = Math.cos(t), s = Math.sin(t), C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}

/** Eigenvectors of a symmetric 3x3 matrix (Jacobi), as matrix columns, by decreasing eigenvalue. */
function principalAxes(cov: M): M {
  const a = [...cov] as M;
  let v: M = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 50; sweep++) {
    let p = 0, q = 1;
    if (Math.abs(a[2]) > Math.abs(a[p * 3 + q]!)) { p = 0; q = 2; }
    if (Math.abs(a[5]) > Math.abs(a[p * 3 + q]!)) { p = 1; q = 2; }
    if (Math.abs(a[p * 3 + q]!) < 1e-12) break;
    const theta = (a[q * 3 + q]! - a[p * 3 + p]!) / (2 * a[p * 3 + q]!);
    const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
    const c = 1 / Math.sqrt(t * t + 1), s = t * c;
    const J: M = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    J[p * 3 + p] = c; J[q * 3 + q] = c; J[p * 3 + q] = s; J[q * 3 + p] = -s;
    const r = mul(mul(transpose(J), a), J);
    for (let i = 0; i < 9; i++) a[i] = r[i]!;
    v = mul(v, J);
  }
  const order = [0, 1, 2].sort((i, j) => a[j * 4]! - a[i * 4]!);
  const out = new Array(9).fill(0) as M;
  order.forEach((col, k) => { for (let row = 0; row < 3; row++) out[row * 3 + k] = v[row * 3 + col]!; });
  // A proper rotation (det +1)
  const det = out[0] * (out[4] * out[8] - out[5] * out[7]) - out[1] * (out[3] * out[8] - out[5] * out[6]) + out[2] * (out[3] * out[7] - out[4] * out[6]);
  if (det < 0) for (let row = 0; row < 3; row++) out[row * 3 + 2] = -out[row * 3 + 2]!;
  return out;
}

function centreAndAxes(ps: V[]): { c: V; axes: M } {
  const c: V = [0, 0, 0];
  for (const p of ps) for (let k = 0; k < 3; k++) c[k] += p[k]! / ps.length;
  const cov = new Array(9).fill(0) as M;
  for (const p of ps) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i * 3 + j] += (p[i]! - c[i]!) * (p[j]! - c[j]!);
  return { c, axes: principalAxes(cov) };
}

const overlap = (a: V[], b: V[]) => {
  let s = 0;
  for (const p of a) for (const q of b) {
    const dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2];
    s += Math.exp(-ALPHA * (dx * dx + dy * dy + dz * dz));
  }
  return s;
};

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function alignOntoLigand(scene: MolScene, ligand: LigandRef, molecule: { positions: Float32Array }): Alignment {
  const P = scene.atoms.positions, E = scene.atoms.element, ri = scene.atoms.residueIndex;
  const residues = scene.tables?.residues ?? [];
  const refIdx = ligandAtoms(scene, ligand).filter((i) => E?.[i] !== 1);
  const ref: V[] = refIdx.map((i) => [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!]);
  const n = molecule.positions.length / 3;
  const mol: V[] = Array.from({ length: n }, (_, k) => [molecule.positions[k * 3]!, molecule.positions[k * 3 + 1]!, molecule.positions[k * 3 + 2]!]);
  if (ref.length === 0 || n === 0) return { positions: molecule.positions, shape: 0, clashes: 0 };

  const R = centreAndAxes(ref), X = centreAndAxes(mol);
  const local: V[] = mol.map((p) => apply(transpose(X.axes), [p[0] - X.c[0], p[1] - X.c[1], p[2] - X.c[2]])); // in the molecule's own axes

  // Polymer heavy atoms near the original ligand
  const polymer = new Uint8Array(residues.length);
  for (const seg of scene.tables?.chainSegments ?? []) for (let r = seg.startResidue; r <= seg.endResidue; r++) polymer[r] = 1;
  const near: V[] = [];
  for (let j = 0; j < scene.atoms.count; j++) {
    if (E?.[j] === 1 || (ri && (!polymer[ri[j]!] || WATER.has(residues[ri[j]!]?.name ?? "")))) continue;
    const dx = P[j * 3]! - R.c[0], dy = P[j * 3 + 1]! - R.c[1], dz = P[j * 3 + 2]! - R.c[2];
    if (dx * dx + dy * dy + dz * dz <= NEIGHBOURHOOD * NEIGHBOURHOOD) near.push([P[j * 3]!, P[j * 3 + 1]!, P[j * 3 + 2]!]);
  }

  const selfRef = overlap(ref, ref), selfMol = overlap(local, local);
  const place = (rot: M, t: V): V[] => local.map((p) => { const q = apply(rot, p); return [q[0] + t[0], q[1] + t[1], q[2] + t[2]]; });
  const evaluate = (pose: V[]) => {
    const o = overlap(pose, ref);
    const shape = o / (selfRef + selfMol - o);
    let penalty = 0, clashes = 0;
    for (const p of pose) for (const q of near) {
      const dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2], d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= CLASH_SOFT * CLASH_SOFT) continue;
      const d = Math.sqrt(d2);
      penalty += (CLASH_SOFT - d) ** 2;
      if (d < CLASH_HARD) clashes++;
    }
    return { score: shape - CLASH_WEIGHT * penalty, shape, clashes };
  };

  // Four proper sign combinations of the molecule's axes onto the original's
  const flips: M[] = [[1, 0, 0, 0, 1, 0, 0, 0, 1], [-1, 0, 0, 0, -1, 0, 0, 0, 1], [-1, 0, 0, 0, 1, 0, 0, 0, -1], [1, 0, 0, 0, -1, 0, 0, 0, -1]];
  const random = rng(12345);
  let best = { rot: R.axes, t: R.c, ...evaluate(place(R.axes, R.c)) };
  for (const flip of flips) {
    let rot = mul(R.axes, flip), t: V = [...R.c];
    let cur = evaluate(place(rot, t));
    for (let step = 0; step < STEPS; step++) {
      const scale = 1 - step / STEPS;
      const u = random() * 2 - 1, phi = random() * 2 * Math.PI, s = Math.sqrt(1 - u * u);
      const dRot = axisAngle([s * Math.cos(phi), s * Math.sin(phi), u], (random() * 2 - 1) * 0.35 * scale);
      const dT: V = [(random() * 2 - 1) * 0.8 * scale, (random() * 2 - 1) * 0.8 * scale, (random() * 2 - 1) * 0.8 * scale];
      const nextRot = mul(dRot, rot), nextT: V = [t[0] + dT[0], t[1] + dT[1], t[2] + dT[2]];
      const next = evaluate(place(nextRot, nextT));
      if (next.score > cur.score) { rot = nextRot; t = nextT; cur = next; }
    }
    if (cur.score > best.score) best = { rot, t, ...cur };
  }
  const pose = place(best.rot, best.t);
  return { positions: Float32Array.from(pose.flat()), shape: best.shape, clashes: best.clashes };
}
