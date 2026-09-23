/*
 Title: chunkedAtoms
 Description: Chunked, level-of-detail atom spheres and bond cylinders built on `chunked`.
 - Atoms: icosphere levels of 1280 / 320 / 80 / 20 triangles by on-screen atom radius.
 - Bonds: open-ended cylinders (the atom spheres cover the ends) with 8 / 5 / 3 sides, hidden entirely
   once a bond is thinner than about half a pixel.
*/
import * as THREE from "three";
import { buildChunked, type ChunkedInstances } from "./chunked";

// IcosahedronGeometry detail d splits each edge into d + 1: 20 (d + 1)^2 triangles
const SPHERE_DETAIL = [7, 3, 1, 0]; // 1280, 320, 80, 20 triangles
const SPHERE_MIN_PX = [28, 9, 3]; // on-screen atom radius for levels 0..2
const BOND_SIDES = [8, 5, 3]; // 16, 10, 6 triangles
const BOND_MIN_PX = [1.5, 0.8, 0.4]; // on-screen bond radius for levels 0..2; thinner: hidden

export interface ChunkedAtomsInput {
  count: number;
  positions: Float32Array;
  radii: Float32Array;
  colors?: Uint8Array; // RGB 0-255 per atom
  radiusScale: number;
  material: THREE.Material;
}

export function buildChunkedAtoms(input: ChunkedAtomsInput): ChunkedInstances {
  const { positions, radii, colors, radiusScale } = input;
  return buildChunked({
    count: input.count,
    point: (i, a) => positions[i * 3 + a]!,
    writeMatrix: (i, m, o) => {
      const r = radii[i]! * radiusScale;
      m[o] = r; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
      m[o + 4] = 0; m[o + 5] = r; m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = r; m[o + 11] = 0;
      m[o + 12] = positions[i * 3]!; m[o + 13] = positions[i * 3 + 1]!; m[o + 14] = positions[i * 3 + 2]!; m[o + 15] = 1;
      return r;
    },
    writeColor: colors ? (i, c, o) => { c[o] = colors[i * 3]! / 255; c[o + 1] = colors[i * 3 + 1]! / 255; c[o + 2] = colors[i * 3 + 2]! / 255; } : undefined,
    levels: SPHERE_DETAIL.map((d) => new THREE.IcosahedronGeometry(1, d)),
    levelMinPx: SPHERE_MIN_PX,
    material: input.material,
  });
}

export interface ChunkedBondsInput {
  count: number;
  indexA: ArrayLike<number>;
  indexB: ArrayLike<number>;
  positions: Float32Array;
  radius: number;
  material: THREE.Material;
}

export function buildChunkedBonds(input: ChunkedBondsInput): ChunkedInstances {
  const { indexA, indexB, positions, radius } = input;
  const up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3(), q = new THREE.Quaternion();
  const pos = new THREE.Vector3(), scale = new THREE.Vector3(), mat = new THREE.Matrix4();
  return buildChunked({
    count: input.count,
    point: (i, a) => (positions[indexA[i]! * 3 + a]! + positions[indexB[i]! * 3 + a]!) / 2,
    writeMatrix: (i, m, o) => {
      const a = indexA[i]! * 3, b = indexB[i]! * 3;
      dir.set(positions[b]! - positions[a]!, positions[b + 1]! - positions[a + 1]!, positions[b + 2]! - positions[a + 2]!);
      const len = dir.length();
      if (len < 1e-6) { for (let k = 0; k < 16; k++) m[o + k] = 0; return 0; } // degenerate: zero scale
      q.setFromUnitVectors(up, dir.multiplyScalar(1 / len));
      pos.set((positions[a]! + positions[b]!) / 2, (positions[a + 1]! + positions[b + 1]!) / 2, (positions[a + 2]! + positions[b + 2]!) / 2);
      mat.compose(pos, q, scale.set(radius, len, radius));
      m.set(mat.elements, o);
      return radius;
    },
    levels: [...BOND_SIDES.map((s) => new THREE.CylinderGeometry(1, 1, 1, s, 1, true)), null],
    levelMinPx: BOND_MIN_PX,
    material: input.material,
  });
}
