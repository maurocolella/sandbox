/*
 Title: ballAndStick
 Description: Ball-and-stick geometry for a small set of atoms (ligands): instanced balls, and bonds as
 sticks showing their order (see bondSticks). Balls take raycasts (instanceId = atom index); sticks don't.
*/
import * as THREE from "three";
import { buildBondSticks } from "./bondSticks";

export interface BallAndStickInput {
  positions: ArrayLike<number>; // xyz per atom
  radius: (i: number) => number;
  color: (i: number, out: THREE.Color) => THREE.Color;
  bonds: [number, number][];
  order?: ArrayLike<number>; // per bond
  aromatic?: ArrayLike<number>; // per bond
  stickRadius: number;
}

export function buildBallAndStick({ positions: P, radius, color: colorOf, bonds, order, aromatic, stickRadius }: BallAndStickInput): { group: THREE.Group; balls: THREE.InstancedMesh | null } {
  const group = new THREE.Group();
  const n = P.length / 3;
  if (n === 0) return { group, balls: null };
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), color = new THREE.Color();

  const balls = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 3), new THREE.MeshStandardMaterial({ roughness: 0.4 }), n);
  for (let i = 0; i < n; i++) {
    const r = radius(i);
    balls.setMatrixAt(i, m.compose(p.set(P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!), q.identity(), s.set(r, r, r)));
    balls.setColorAt(i, colorOf(i, color));
  }
  balls.computeBoundingSphere(); // for click raycasts
  group.add(balls);

  const sticks = buildBondSticks({ positions: P, bonds, order, aromatic, radius: stickRadius, color: colorOf });
  if (sticks) group.add(sticks);
  return { group, balls };
}

export function disposeGroup(group: THREE.Group) {
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
  });
}
