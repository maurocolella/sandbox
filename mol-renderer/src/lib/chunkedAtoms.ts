/*
 Title: chunkedAtoms
 Description: Chunked, level-of-detail atom spheres and bond cylinders built on `chunked`.
 - Atoms: the original 480-triangle UV sphere up close (never more), then icospheres of 320 / 80 / 20.
 - Bonds: open-ended cylinders (the atom spheres cover the ends) with 12 / 8 / 5 / 3 sides, hidden once
   thinner than a quarter pixel.
 Level thresholds come from each level's geometric error, so switches happen where they are invisible.
*/
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { buildChunked, type ChunkedInstances } from "./chunked";

/**
 * Indexed icosphere. Three's IcosahedronGeometry is non-indexed (3 vertices per triangle, none shared);
 * with instancing, vertex work dominates, so merging shared vertices cuts it ~6x (1280 triangles: 3840 -> 642
 * vertices). UVs are dropped first: their seams would otherwise keep duplicates apart.
 */
function icosphere(detail: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute("uv");
  const indexed = mergeVertices(g);
  g.dispose();
  return indexed;
}

// Each level is used only while its largest deviation from the true shape stays under MAX_ERROR_PX on
// screen, so a switch happens where the two levels look the same.
const MAX_ERROR_PX = 0.5;

// Spheres: finest is SphereGeometry(16, 16), the fixed sphere the viewer always used (480 triangles, 289
// vertices; its largest deviation is about 1 - cos(pi / 16)). Coarser levels are icospheres:
// IcosahedronGeometry detail d splits each edge into d + 1 (20 (d + 1)^2 triangles); the edge's central
// angle is atan(2) / (d + 1) and the largest deviation (at a face center) about 1 - cos(angle / sqrt3).
const UV_SEGMENTS = 16;
const ICO_DETAIL = [3, 1, 0]; // 320, 80, 20 triangles
const icoError = (d: number) => 1 - Math.cos(Math.atan(2) / (d + 1) / Math.sqrt(3));
const SPHERE_ERRORS = [1 - Math.cos(Math.PI / UV_SEGMENTS), ...ICO_DETAIL.map(icoError)];
// Bonds: an n-sided prism deviates from its cylinder by 1 - cos(pi / n); hidden below HIDE_BOND_PX
const BOND_SIDES = [12, 8, 5, 3]; // 24, 16, 10, 6 triangles
const bondError = (n: number) => 1 - Math.cos(Math.PI / n);
const HIDE_BOND_PX = 0.25;

/** Minimum on-screen feature radius for each level but the last: the size at which the next level's error hits the limit. */
const minPxFor = (errors: number[]) => errors.slice(1).map((e) => MAX_ERROR_PX / e);
const SPHERE_MIN_PX = minPxFor(SPHERE_ERRORS); // ~39, 9.9, 2.5 px
const BOND_MIN_PX = [...minPxFor(BOND_SIDES.map(bondError)), HIDE_BOND_PX]; // ~6.6, 2.6, 1.0, 0.25 px

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
    levels: [new THREE.SphereGeometry(1, UV_SEGMENTS, UV_SEGMENTS), ...ICO_DETAIL.map(icosphere)],
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
