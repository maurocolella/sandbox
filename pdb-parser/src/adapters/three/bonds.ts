import * as THREE from "three";
import type { MolScene } from "../../types/molScene.js";

/**
 * Options for building simple bond line segments from MolScene bonds.
 */
export interface BondLineOptions {
  color?: number | string | THREE.Color; // fallback if no per-vertex colors
}

/**
 * Create a THREE.LineSegments object from MolScene bonds.
 *
 * - Uses scene.bonds index pairs and scene.atoms.positions
 * - Colors default to atom colors (per-vertex); falls back to gray
 *
 * @param scene MolScene with optional bonds
 * @param opts Optional rendering parameters
 * @returns LineSegments or undefined if no bonds exist
 */
export function makeBondLines(scene: MolScene, opts: BondLineOptions = {}): THREE.LineSegments | undefined {
  const bonds = scene.bonds;
  if (!bonds || bonds.count === 0) return undefined;

  const positions = scene.atoms.positions;
  const colors = scene.atoms.colors;

  const bCount = bonds.count;
  const indexA = bonds.indexA;
  const indexB = bonds.indexB;

  const posArr = new Float32Array(bCount * 2 * 3);
  const colArr = new Float32Array(bCount * 2 * 3);

  for (let i = 0; i < bCount; i++) {
    const ia = indexA[i]!;
    const ib = indexB[i]!;

    const ax = positions[ia * 3];
    const ay = positions[ia * 3 + 1];
    const az = positions[ia * 3 + 2];
    const bx = positions[ib * 3];
    const by = positions[ib * 3 + 1];
    const bz = positions[ib * 3 + 2];

    const o = i * 6;
    posArr[o] = ax; posArr[o + 1] = ay; posArr[o + 2] = az;
    posArr[o + 3] = bx; posArr[o + 4] = by; posArr[o + 5] = bz;

    if (colors) {
      const acr = colors[ia * 3] / 255, acg = colors[ia * 3 + 1] / 255, acb = colors[ia * 3 + 2] / 255;
      const bcr = colors[ib * 3] / 255, bcg = colors[ib * 3 + 1] / 255, bcb = colors[ib * 3 + 2] / 255;
      colArr[o] = acr; colArr[o + 1] = acg; colArr[o + 2] = acb;
      colArr[o + 3] = bcr; colArr[o + 4] = bcg; colArr[o + 5] = bcb;
    } else {
      // default gray
      colArr[o] = 0.7; colArr[o + 1] = 0.7; colArr[o + 2] = 0.7;
      colArr[o + 3] = 0.7; colArr[o + 4] = 0.7; colArr[o + 5] = 0.7;
    }
  }

  const bGeo = new THREE.BufferGeometry();
  bGeo.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
  bGeo.setAttribute("color", new THREE.BufferAttribute(colArr, 3));
  bGeo.computeBoundingSphere();

  const bMat = new THREE.LineBasicMaterial({ vertexColors: true });
  return new THREE.LineSegments(bGeo, bMat);
}
