import { useEffect } from "react";
import type { MolScene } from "pdb-parser";
import { Vector3 } from "three";

export type ControlsRef = {
  target: Vector3;
  object: { position: Vector3; fov?: number; updateProjectionMatrix?: () => void };
  update: () => void;
};

export function useCameraFrameOnScene(scene: MolScene | null, controlsRef: ControlsRef | null, loading: boolean) {
  useEffect(() => {
    if (!scene || loading) return;
    if (!controlsRef) return;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    if (scene.bbox) {
      [minX, minY, minZ] = scene.bbox.min;
      [maxX, maxY, maxZ] = scene.bbox.max;
    } else {
      const a = scene.atoms;
      if (a && a.count > 0) {
        const p = a.positions;
        for (let i = 0; i < a.count; i++) {
          const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
          if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
          if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
        }
      }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return;

    const c = new Vector3((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
    const sizeX = Math.max(1e-6, maxX - minX);
    const sizeY = Math.max(1e-6, maxY - minY);

    const ctrl = controlsRef;
    const cam = ctrl.object;
    const vFov = (cam.fov ?? 60) * Math.PI / 180;
    const aspect = (typeof window !== "undefined" && window.innerHeight > 0)
      ? (window.innerWidth / window.innerHeight)
      : 1.6;
    const halfW = sizeX * 0.5;
    const halfH = sizeY * 0.5;
    const distY = halfH / Math.tan(vFov / 2);
    const distX = halfW / (Math.tan(vFov / 2) * aspect);
    const margin = 1.6;
    const desiredDist = Math.max(distX, distY) * margin;

    ctrl.target.copy(c);
    const dir = cam.position.clone().sub(ctrl.target).normalize();
    if (!Number.isFinite(dir.x) || !Number.isFinite(dir.y) || !Number.isFinite(dir.z) || dir.lengthSq() < 1e-6) {
      dir.set(0, 0, 1);
    }
    cam.position.copy(c.clone().add(dir.multiplyScalar(desiredDist)));
    cam.updateProjectionMatrix?.();
    ctrl.update();
  }, [scene, controlsRef, loading]);
}
