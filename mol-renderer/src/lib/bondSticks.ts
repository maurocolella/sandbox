/*
 Title: bondSticks
 Description: Bonds as sticks showing their order (PyMOL "valence"): single bonds as one stick, double as
 two thinner parallel sticks in the plane of a neighbouring bond, triple as three, and aromatic bonds as a
 stick plus a dashed inner line toward their ring's centre. Each half of a stick takes its atom's colour.
 Also perceives aromatic rings in molecules whose bonds are given in Kekulé form only (as PubChem's SDF).
*/
import * as THREE from "three";

export interface BondSticksInput {
  positions: ArrayLike<number>; // xyz per atom
  bonds: [number, number][];
  order?: ArrayLike<number>; // per bond, 1 when absent
  aromatic?: ArrayLike<number>; // per bond, 1 = aromatic
  radius: number;
  color: (atom: number, out: THREE.Color) => THREE.Color;
  radialSegments?: number;
}

const DASH = 0.22, GAP = 0.14; // Å, aromatic inner line

/** Atoms of the smallest ring through bond a-b (at most `maxSize` atoms), using only edges in `adj`. */
function smallestRing(a: number, b: number, adj: number[][], maxSize = 8): number[] | null {
  // Shortest path b -> a not using the a-b edge
  const prev = new Map<number, number>([[b, -1]]);
  let frontier = [b];
  for (let depth = 1; depth < maxSize && frontier.length; depth++) {
    const next: number[] = [];
    for (const u of frontier) for (const v of adj[u]!) {
      if (u === b && v === a) continue;
      if (prev.has(v)) continue;
      prev.set(v, u);
      if (v === a) {
        const ring: number[] = [];
        for (let x = a; x !== -1; x = prev.get(x)!) ring.push(x);
        return ring;
      }
      next.push(v);
    }
    frontier = next;
  }
  return null;
}

/**
 * Aromatic flags for bonds given in Kekulé form: a 6-ring is aromatic when each of its atoms has a double
 * bond within the ring system; a 5-ring when four do and the fifth is N, O or S (pyrrole, furan, thiophene).
 */
export function perceiveAromatic(n: number, elements: string[], bonds: [number, number][], order: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(bonds.length);
  const adj: number[][] = Array.from({ length: n }, () => []);
  bonds.forEach(([a, b]) => { adj[a]!.push(b); adj[b]!.push(a); });
  const rings = new Map<string, number[]>();
  for (const [a, b] of bonds) {
    const r = smallestRing(a, b, adj, 6);
    if (r && r.length >= 5) rings.set([...r].sort((x, y) => x - y).join(","), r);
  }
  const inRing = new Uint8Array(n);
  for (const r of rings.values()) for (const a of r) inRing[a] = 1;
  const doubleInSystem = new Uint8Array(n);
  bonds.forEach(([a, b], k) => { if (order[k] === 2 && inRing[a] && inRing[b]) { doubleInSystem[a] = 1; doubleInSystem[b] = 1; } });
  const bondIndex = new Map<string, number>();
  bonds.forEach(([a, b], k) => bondIndex.set(a < b ? `${a},${b}` : `${b},${a}`, k));
  for (const r of rings.values()) {
    const without = r.filter((a) => !doubleInSystem[a]);
    const aromatic = r.length === 6 ? without.length === 0
      : without.length === 1 && ["N", "O", "S"].includes(elements[without[0]!]!.toUpperCase());
    if (!aromatic) continue;
    for (let i = 0; i < r.length; i++) {
      const a = r[i]!, b = r[(i + 1) % r.length]!;
      const k = bondIndex.get(a < b ? `${a},${b}` : `${b},${a}`);
      if (k !== undefined) out[k] = 1;
    }
  }
  return out;
}

export function buildBondSticks({ positions: P, bonds, order, aromatic, radius, color: colorOf, radialSegments = 12 }: BondSticksInput): THREE.InstancedMesh | null {
  if (bonds.length === 0) return null;
  const n = P.length / 3;
  const at = (i: number, out: THREE.Vector3) => out.set(P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!);
  const adj: number[][] = Array.from({ length: n }, () => []);
  const aromAdj: number[][] = Array.from({ length: n }, () => []);
  bonds.forEach(([a, b], k) => {
    adj[a]!.push(b); adj[b]!.push(a);
    if (aromatic?.[k]) { aromAdj[a]!.push(b); aromAdj[b]!.push(a); }
  });

  const pieces: { from: THREE.Vector3; to: THREE.Vector3; r: number; atom: number }[] = [];
  const pa = new THREE.Vector3(), pb = new THREE.Vector3(), u = new THREE.Vector3(), w = new THREE.Vector3(), tmp = new THREE.Vector3();
  // Both halves of a (possibly offset) stick
  const stick = (a: number, b: number, offset: THREE.Vector3, r: number, shrink = 0) => {
    const from = at(a, new THREE.Vector3()).add(offset), to = at(b, new THREE.Vector3()).add(offset);
    const d = to.clone().sub(from);
    from.addScaledVector(d, shrink); to.addScaledVector(d, -shrink);
    const mid = from.clone().add(to).multiplyScalar(0.5);
    pieces.push({ from, to: mid, r, atom: a }, { from: mid.clone(), to, r, atom: b });
  };
  /** Unit vector perpendicular to a-b, toward `target` (or any neighbour of a or b, or any perpendicular). */
  const perpendicular = (a: number, b: number, target: THREE.Vector3 | null, out: THREE.Vector3) => {
    at(a, pa); at(b, pb);
    u.subVectors(pb, pa).normalize();
    if (!target) {
      const c = adj[a]!.find((x) => x !== b) ?? adj[b]!.find((x) => x !== a);
      target = c !== undefined ? at(c, tmp) : null;
    }
    if (target) {
      out.subVectors(target, pa);
      out.addScaledVector(u, -out.dot(u));
      if (out.lengthSq() > 1e-6) return out.normalize();
    }
    out.set(1, 0, 0);
    if (Math.abs(u.x) > 0.9) out.set(0, 1, 0);
    return out.addScaledVector(u, -out.dot(u)).normalize();
  };

  const zero = new THREE.Vector3();
  bonds.forEach(([a, b], k) => {
    const ord = order?.[k] ?? 1;
    if (aromatic?.[k]) {
      stick(a, b, zero, radius);
      const ring = smallestRing(a, b, aromAdj);
      if (!ring) return;
      const centre = new THREE.Vector3();
      for (const x of ring) centre.add(at(x, tmp));
      centre.divideScalar(ring.length);
      perpendicular(a, b, centre, w).multiplyScalar(radius * 2.6);
      // Dashed inner line, shortened at both ends
      const from = at(a, new THREE.Vector3()).add(w), to = at(b, new THREE.Vector3()).add(w);
      const d = to.clone().sub(from), len = d.length();
      const start = len * 0.18, end = len * 0.82;
      d.normalize();
      for (let s = start; s < end; s += DASH + GAP) {
        const e = Math.min(end, s + DASH);
        const p0 = from.clone().addScaledVector(d, s), p1 = from.clone().addScaledVector(d, e);
        pieces.push({ from: p0, to: p1, r: radius * 0.45, atom: (s + e) / 2 < len / 2 ? a : b });
      }
    } else if (ord === 2) {
      perpendicular(a, b, null, w).multiplyScalar(radius * 1.15);
      stick(a, b, w, radius * 0.6);
      stick(a, b, w.clone().negate(), radius * 0.6);
    } else if (ord === 3) {
      perpendicular(a, b, null, w).multiplyScalar(radius * 1.6);
      stick(a, b, zero, radius * 0.5);
      stick(a, b, w, radius * 0.5);
      stick(a, b, w.clone().negate(), radius * 0.5);
    } else stick(a, b, zero, radius);
  });

  const mesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, radialSegments, 1, false), new THREE.MeshStandardMaterial({ roughness: 0.4 }), pieces.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), color = new THREE.Color();
  pieces.forEach(({ from, to, r, atom }, k) => {
    u.subVectors(to, from);
    const len = u.length();
    q.setFromUnitVectors(up, u.normalize());
    mesh.setMatrixAt(k, m.compose(p.addVectors(from, to).multiplyScalar(0.5), q, s.set(r, len, r)));
    mesh.setColorAt(k, colorOf(atom, color));
  });
  mesh.raycast = () => {};
  return mesh;
}
