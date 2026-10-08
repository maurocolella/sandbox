/*
 Title: ballAndStick
 Description: Ball-and-stick geometry for a small set of atoms (ligands): instanced balls, and bonds as two
 half-sticks each taking its atom's colour. Balls take raycasts (instanceId = atom index); sticks don't.
*/
import * as THREE from "three";

export interface BallAndStickInput {
  positions: ArrayLike<number>; // xyz per atom
  radius: (i: number) => number;
  color: (i: number, out: THREE.Color) => THREE.Color;
  bonds: [number, number][];
  stickRadius: number;
}

export function buildBallAndStick({ positions: P, radius, color: colorOf, bonds, stickRadius }: BallAndStickInput): { group: THREE.Group; balls: THREE.InstancedMesh | null } {
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

  if (bonds.length > 0) {
    const sticks = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 12, 1, true), new THREE.MeshStandardMaterial({ roughness: 0.4 }), bonds.length * 2);
    const up = new THREE.Vector3(0, 1, 0), from = new THREE.Vector3(), to = new THREE.Vector3(), dir = new THREE.Vector3();
    let k = 0;
    for (const [x, y] of bonds) {
      for (const [a, b] of [[x, y], [y, x]] as const) {
        from.set(P[a * 3]!, P[a * 3 + 1]!, P[a * 3 + 2]!);
        to.set(P[b * 3]!, P[b * 3 + 1]!, P[b * 3 + 2]!).add(from).multiplyScalar(0.5); // to the bond's middle
        dir.subVectors(to, from);
        const len = dir.length();
        q.setFromUnitVectors(up, dir.normalize());
        sticks.setMatrixAt(k, m.compose(p.addVectors(from, to).multiplyScalar(0.5), q, s.set(stickRadius, len, stickRadius)));
        sticks.setColorAt(k++, colorOf(a, color));
      }
    }
    sticks.raycast = () => {};
    group.add(sticks);
  }
  return { group, balls };
}

export function disposeGroup(group: THREE.Group) {
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
  });
}
