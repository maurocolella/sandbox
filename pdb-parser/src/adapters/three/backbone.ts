import * as THREE from "three";
import type { MolScene } from "../../types/molScene.js";

/**
 * Options for building backbone line segments from MolScene.backbone.
 */
export interface BackboneLineOptions {
  color?: number | string | THREE.Color;
  materialKind?: "basic" | "lambert" | "standard";
}

/**
 * Create a THREE.LineSegments object for the backbone polyline.
 *
 * - Uses scene.backbone.positions (Float32Array of points)
 * - Uses scene.backbone.segments (Uint32Array pairs [start, end) in point indices)
 * - Connects consecutive points within each segment to form a polyline
 *
 * @param scene MolScene with optional backbone polyline
 * @param opts Optional rendering parameters
 * @returns LineSegments or undefined if no backbone exists
 */
export function makeBackboneLines(
  scene: MolScene,
  opts: BackboneLineOptions = {}
): THREE.LineSegments | undefined {
  const backbone = scene.backbone;
  if (!backbone) return undefined;

  const { color = 0xffffff, materialKind = "basic" } = opts;

  const positions = backbone.positions; // Float32Array of points
  const segments = backbone.segments;   // Uint32Array [start, end) pairs in point indices

  let lineCount = 0;
  for (let i = 0; i < segments.length; i += 2) {
    const s = segments[i]!;
    const e = segments[i + 1]!;
    if (e - s >= 2) lineCount += (e - s - 1);
  }
  if (lineCount === 0) return undefined;

  const indexArr = new Uint32Array(lineCount * 2);
  let w = 0;
  for (let i = 0; i < segments.length; i += 2) {
    const s = segments[i]!;
    const e = segments[i + 1]!;
    for (let j = s; j < e - 1; j++) {
      indexArr[w++] = j;
      indexArr[w++] = j + 1;
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setIndex(new THREE.BufferAttribute(indexArr, 1));
  geom.computeBoundingSphere();

  const material = new THREE.LineBasicMaterial({ color: new THREE.Color(color) });
  return new THREE.LineSegments(geom, material);
}
