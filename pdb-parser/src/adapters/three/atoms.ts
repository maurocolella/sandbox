import * as THREE from "three";
import type { MolScene } from "../../types/molScene.js";

/**
 * Options for building an instanced mesh of atom spheres.
 */
export interface AtomMeshOptions {
  sphereDetail?: number;
  materialKind?: "basic" | "lambert" | "standard";
  /** Global multiplier applied to each atom's base radius (default 1.0). */
  radiusScale?: number;
}

/**
 * Create a THREE.InstancedMesh of atom spheres from a MolScene.
 *
 * - Uses scene.atoms.positions (Float32Array) for placement
 * - Uses scene.atoms.radii (Float32Array) for per-instance scale
 * - Uses scene.atoms.colors (Uint8Array RGB) for per-instance color if present
 *
 * @param scene MolScene produced by parsePdbToMolScene
 * @param opts Optional rendering parameters
 * @returns InstancedMesh ready to add to a THREE.Scene
 */
export function makeAtomsMesh(scene: MolScene, opts: AtomMeshOptions = {}): THREE.InstancedMesh {
  const { sphereDetail = 16, materialKind = "standard" } = opts;
  const radiusScale = opts.radiusScale ?? 1.0;

  const count = scene.atoms.count;
  const positions = scene.atoms.positions;
  const radii = scene.atoms.radii;
  const colors = scene.atoms.colors;

  const geometry = new THREE.SphereGeometry(1, sphereDetail, sphereDetail);

  // Enable vertexColors when we have per-instance colors so shaders use instanceColor.
  const useInstanceColors = !!colors;
  const material =
    materialKind === "basic"
      ? new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: useInstanceColors })
      : materialKind === "lambert"
      ? new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: useInstanceColors })
      : new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0, roughness: 1, vertexColors: useInstanceColors });

  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const r = radii[i] * radiusScale;

    dummy.position.set(x, y, z);
    dummy.scale.set(r, r, r);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);

    if (colors) {
      const cr = colors[i * 3] / 255;
      const cg = colors[i * 3 + 1] / 255;
      const cb = colors[i * 3 + 2] / 255;
      color.setRGB(cr, cg, cb);
      mesh.setColorAt(i, color);
    }
  }

  mesh.instanceMatrix.needsUpdate = true;
  if ((mesh as any).instanceColor) {
    (mesh as any).instanceColor.needsUpdate = true;
  }

  return mesh;
}
