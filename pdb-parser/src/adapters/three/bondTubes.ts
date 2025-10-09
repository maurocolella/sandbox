import * as THREE from "three";
import type { MolScene } from "../../types/molScene.js";

export interface BondTubeOptions {
  radius?: number;
  radialSegments?: number; // cylinder radial segments
  materialKind?: "basic" | "lambert" | "standard";
  color?: number | string | THREE.Color;
}

/**
 * Create an InstancedMesh of thin cylinders for bonds.
 * Oriented along each bond vector with midpoint placement.
 */
export function makeBondTubes(scene: MolScene, opts: BondTubeOptions = {}): THREE.InstancedMesh | undefined {
  const bonds = scene.bonds;
  if (!bonds || bonds.count === 0) return undefined;

  const positions = scene.atoms.positions;
  const count = bonds.count;

  const radius = opts.radius ?? 0.06;
  const radialSegments = Math.max(6, Math.floor(opts.radialSegments ?? 10));
  const geometry = new THREE.CylinderGeometry(radius, radius, 1, radialSegments, 1, false);
  // Orient cylinder along Y by default; we'll rotate to match bond vector.

  let material: THREE.Material;
  const color = new THREE.Color(opts.color ?? 0xaaaaaa);
  switch (opts.materialKind) {
    case "basic":
      material = new THREE.MeshBasicMaterial({ color });
      break;
    case "lambert":
      material = new THREE.MeshLambertMaterial({ color });
      break;
    case "standard":
    default:
      material = new THREE.MeshStandardMaterial({ color, metalness: 0.0, roughness: 0.8 });
      break;
  }

  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const tmpMat = new THREE.Matrix4();
  const tmpQuat = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);

  const indexA = bonds.indexA;
  const indexB = bonds.indexB;

  for (let i = 0; i < count; i++) {
    const ia = indexA[i]!;
    const ib = indexB[i]!;

    a.set(positions[ia * 3]!, positions[ia * 3 + 1]!, positions[ia * 3 + 2]!);
    b.set(positions[ib * 3]!, positions[ib * 3 + 1]!, positions[ib * 3 + 2]!);

    dir.subVectors(b, a);
    const len = dir.length();
    if (len <= 1e-6) {
      // degenerate; skip drawing by setting zero scale
      scale.set(0, 0, 0);
      pos.copy(a);
      tmpQuat.identity();
    } else {
      dir.normalize();
      tmpQuat.setFromUnitVectors(up, dir);
      pos.addVectors(a, b).multiplyScalar(0.5);
      scale.set(1, len, 1);
    }

    tmpMat.compose(pos, tmpQuat, scale);
    mesh.setMatrixAt(i, tmpMat);
  }

  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}
