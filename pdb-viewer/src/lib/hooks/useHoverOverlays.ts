import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { MolScene } from "pdb-parser";

export interface HoverOverlaysOptions {
  mode: "atom" | "residue" | "chain";
  hoveredAtom: number;
  hoveredResidue: number;
  hoveredChain: number;
  color: THREE.ColorRepresentation;
  radiusScale: number;
  sphereDetail: number;
  bondRadius?: number; // default ~ tube radius
  bondSegments?: number; // cylinder radial segments
  scale?: number; // sphere scale multiplier to pop above (default 1.05)
}

export function useHoverOverlays(
  scene: MolScene | null,
  opts: HoverOverlaysOptions
) {
  const atomOverlay = useRef<THREE.InstancedMesh | null>(null);
  const bondOverlay = useRef<THREE.InstancedMesh | null>(null);
  const sphereGeomRef = useRef<THREE.SphereGeometry | null>(null);
  const cylGeomRef = useRef<THREE.CylinderGeometry | null>(null);

  // Build overlay meshes and materials
  useEffect(() => {
    // return
    if (!scene) return;

    const color = new THREE.Color(opts.color);

    // Atom overlay
    sphereGeomRef.current?.dispose();
    sphereGeomRef.current = new THREE.SphereGeometry(1, opts.sphereDetail, opts.sphereDetail);
    const atomMat = new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false, depthWrite: false });
    const aMesh = new THREE.InstancedMesh(sphereGeomRef.current, atomMat, scene.atoms.count);
    (aMesh as unknown as { raycast?: (...args: unknown[]) => void }).raycast = () => { };
    aMesh.count = 0;
    atomOverlay.current = aMesh;

    // Bond overlay
    cylGeomRef.current?.dispose();
    const bondRadius = opts.bondRadius ?? 0.06;
    const bondSegs = Math.max(6, Math.floor(opts.bondSegments ?? 12));
    cylGeomRef.current = new THREE.CylinderGeometry(bondRadius, bondRadius, 1, bondSegs, 1, false);
    if (scene.bonds && scene.bonds.count > 0) {
      const bondMat = new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false, depthWrite: false });
      const bMesh = new THREE.InstancedMesh(cylGeomRef.current, bondMat, scene.bonds.count);
      (bMesh as unknown as { raycast?: (...args: unknown[]) => void }).raycast = () => { };
      bMesh.count = 0;
      bondOverlay.current = bMesh;
    } else {
      bondOverlay.current = null;
    }

    return () => {
      (atomOverlay.current?.material as THREE.Material | undefined)?.dispose?.();
      if (bondOverlay.current) (bondOverlay.current.material as THREE.Material | undefined)?.dispose?.();
      atomOverlay.current = null;
      bondOverlay.current = null;
      sphereGeomRef.current?.dispose();
      cylGeomRef.current?.dispose();
      sphereGeomRef.current = null;
      cylGeomRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, opts.sphereDetail, opts.color]);

  // Update instance transforms when hover changes
  useEffect(() => {
    // return
    if (!scene) return;

    // Only support overlays for single-atom highlighting to keep updates light.

    // Atom overlay update
    if (atomOverlay.current) {
      const m = new THREE.Matrix4();
      const s = new THREE.Vector3();
      const pos = new THREE.Vector3();
      const radii = scene.atoms.radii;
      const scaleMul = opts.scale ?? 1.05;
      let w = 0;

      if (opts.mode === "atom" && opts.hoveredAtom >= 0) {
        const i = opts.hoveredAtom;
        const r = radii[i]! * opts.radiusScale * scaleMul;
        pos.set(scene.atoms.positions[i * 3]!, scene.atoms.positions[i * 3 + 1]!, scene.atoms.positions[i * 3 + 2]!);
        s.set(r, r, r);
        m.compose(pos, new THREE.Quaternion(), s);
        atomOverlay.current.setMatrixAt(w++, m);
      } else if (opts.mode === "chain" && opts.hoveredChain >= 0 && scene.atoms.chainIndex) {
        const ci = scene.atoms.chainIndex;
        for (let i = 0; i < scene.atoms.count; i++) {
          if (ci[i] !== opts.hoveredChain) continue;
          const r = radii[i]! * opts.radiusScale * scaleMul;
          pos.set(scene.atoms.positions[i * 3]!, scene.atoms.positions[i * 3 + 1]!, scene.atoms.positions[i * 3 + 2]!);
          s.set(r, r, r);
          m.compose(pos, new THREE.Quaternion(), s);
          atomOverlay.current.setMatrixAt(w++, m);
        }
      } else if (opts.mode === "residue" && opts.hoveredResidue >= 0 && scene.atoms.residueIndex) {
        const ri = scene.atoms.residueIndex;
        for (let i = 0; i < scene.atoms.count; i++) {
          if (ri[i] !== opts.hoveredResidue) continue;
          const r = radii[i]! * opts.radiusScale * scaleMul;
          pos.set(scene.atoms.positions[i * 3]!, scene.atoms.positions[i * 3 + 1]!, scene.atoms.positions[i * 3 + 2]!);
          s.set(r, r, r);
          m.compose(pos, new THREE.Quaternion(), s);
          atomOverlay.current.setMatrixAt(w++, m);
        }
      }

      atomOverlay.current.count = w;
      atomOverlay.current.instanceMatrix.needsUpdate = true;
    }

    // Bond overlay update
    if (bondOverlay.current && scene.bonds) {
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0);
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const dir = new THREE.Vector3();
      const pos = new THREE.Vector3();
      const indexA = scene.bonds.indexA;
      const indexB = scene.bonds.indexB;
      const chainIndex = scene.atoms.chainIndex;
      const residueIndex = scene.atoms.residueIndex;
      let w = 0;

      for (let i = 0; i < scene.bonds.count; i++) {
        const ia = indexA[i]!;
        const ib = indexB[i]!;
        const match = (opts.mode === "atom" && opts.hoveredAtom >= 0 && (ia === opts.hoveredAtom || ib === opts.hoveredAtom))
          || (opts.mode === "chain" && opts.hoveredChain >= 0 && chainIndex && (chainIndex[ia] === opts.hoveredChain || chainIndex[ib] === opts.hoveredChain))
          || (opts.mode === "residue" && opts.hoveredResidue >= 0 && residueIndex && (residueIndex[ia] === opts.hoveredResidue || residueIndex[ib] === opts.hoveredResidue));
        if (!match) continue;
        a.set(scene.atoms.positions[ia * 3]!, scene.atoms.positions[ia * 3 + 1]!, scene.atoms.positions[ia * 3 + 2]!);
        b.set(scene.atoms.positions[ib * 3]!, scene.atoms.positions[ib * 3 + 1]!, scene.atoms.positions[ib * 3 + 2]!);
        dir.subVectors(b, a);
        const len = dir.length();
        if (len <= 1e-6) continue;
        dir.normalize();
        q.setFromUnitVectors(up, dir);
        pos.addVectors(a, b).multiplyScalar(0.5);
        m.compose(pos, q, new THREE.Vector3(1, len, 1));
        bondOverlay.current.setMatrixAt(w++, m);
      }
      bondOverlay.current.count = w;
      bondOverlay.current.instanceMatrix.needsUpdate = true;
    }
  }, [scene, opts.mode, opts.hoveredAtom, opts.hoveredResidue, opts.hoveredChain, opts.radiusScale, opts.scale]);

  return { atomOverlay: atomOverlay.current, bondOverlay: bondOverlay.current };
}
