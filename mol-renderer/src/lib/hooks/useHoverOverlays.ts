/*
 Title: useHoverOverlays
 Description: Creates instanced overlay meshes (atoms/bonds) to visualize hover selection.
 Supports on-top rendering or depth-tested rendering, and updates instance transforms on hover changes.
*/
import { useEffect, useRef } from "react";
import type { MolScene } from "pdb-parser";
import type { SelectionLookups } from "./useSelectionLookups";
import { type ColorRepresentation, InstancedMesh, SphereGeometry, CylinderGeometry, Color, MeshBasicMaterial, DynamicDrawUsage, Material, Matrix4, Vector3, Quaternion } from "three";

export interface HoverOverlaysOptions {
  mode: "atom" | "residue" | "chain";
  hoveredAtom: number;
  hoveredResidue: number;
  hoveredChain: number;
  color: ColorRepresentation;
  radiusScale: number;
  sphereDetail: number;
  bondRadius?: number; // default ~ tube radius
  bondSegments?: number; // cylinder radial segments
  scale?: number; // sphere scale multiplier to pop above (default 1.05)
  onTop?: boolean;
}

export function useHoverOverlays(
  scene: MolScene | null,
  opts: HoverOverlaysOptions,
  lookups?: SelectionLookups
) {
  const atomOverlay = useRef<InstancedMesh | null>(null);
  const bondOverlay = useRef<InstancedMesh | null>(null);
  const sphereGeomRef = useRef<SphereGeometry | null>(null);
  const cylGeomRef = useRef<CylinderGeometry | null>(null);

  // Build overlay meshes and materials
  useEffect(() => {
    // return
    if (!scene) return;

    const color = new Color(opts.color);
    const onTop = Boolean(opts.onTop);

    // Atom overlay
    sphereGeomRef.current?.dispose();
    sphereGeomRef.current = new SphereGeometry(1, opts.sphereDetail, opts.sphereDetail);
    const atomMat = new MeshBasicMaterial({ color, transparent: true, depthTest: !onTop, depthWrite: !onTop });
    const aMesh = new InstancedMesh(sphereGeomRef.current, atomMat, scene.atoms.count);
    (aMesh as unknown as { raycast?: (...args: unknown[]) => void }).raycast = () => { };
    aMesh.count = 0;
    aMesh.frustumCulled = false;
    aMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    atomOverlay.current = aMesh;

    // Bond overlay
    cylGeomRef.current?.dispose();
    const bondRadius = opts.bondRadius ?? 0.06;
    const bondSegs = Math.max(6, Math.floor(opts.bondSegments ?? 12));
    cylGeomRef.current = new CylinderGeometry(bondRadius, bondRadius, 1, bondSegs, 1, false);
    if (scene.bonds && scene.bonds.count > 0) {
      const bondMat = new MeshBasicMaterial({ color, transparent: true, depthTest: !onTop, depthWrite: !onTop });
      const bMesh = new InstancedMesh(cylGeomRef.current, bondMat, scene.bonds.count);
      (bMesh as unknown as { raycast?: (...args: unknown[]) => void }).raycast = () => { };
      bMesh.count = 0;
      bMesh.frustumCulled = false;
      bMesh.instanceMatrix.setUsage(DynamicDrawUsage);
      bondOverlay.current = bMesh;
    } else {
      bondOverlay.current = null;
    }

    return () => {
      (atomOverlay.current?.material as Material | undefined)?.dispose?.();
      if (bondOverlay.current) (bondOverlay.current.material as Material | undefined)?.dispose?.();
      atomOverlay.current = null;
      bondOverlay.current = null;
      sphereGeomRef.current?.dispose();
      cylGeomRef.current?.dispose();
      sphereGeomRef.current = null;
      cylGeomRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, opts.sphereDetail, opts.color, opts.onTop]);

  // React to onTop toggle without full rebuild (safety net)
  useEffect(() => {
    const onTop = Boolean(opts.onTop);
    if (atomOverlay.current) {
      const mat = atomOverlay.current.material as MeshBasicMaterial;
      mat.depthTest = !onTop;
      mat.depthWrite = !onTop;
      mat.needsUpdate = true;
    }
    if (bondOverlay.current) {
      const mat = bondOverlay.current.material as MeshBasicMaterial;
      mat.depthTest = !onTop;
      mat.depthWrite = !onTop;
      mat.needsUpdate = true;
    }
  }, [opts.onTop]);

  // Update instance transforms when hover changes
  useEffect(() => {
    // return
    if (!scene) return;

    // Only support overlays for single-atom highlighting to keep updates light.

    const mRef = { current: new Matrix4() };
    const sRef = { current: new Vector3() };
    const posRef = { current: new Vector3() };
    const qRef = { current: new Quaternion() };
    const upRef = { current: new Vector3(0, 1, 0) };
    const aRef = { current: new Vector3() };
    const bRef = { current: new Vector3() };
    const dirRef = { current: new Vector3() };

    if (atomOverlay.current) {
      const radii = scene.atoms.radii;
      const scaleMul = opts.scale ?? 1.05;
      let w = 0;

      let atomIdxs: number[] | undefined;
      if (opts.mode === "atom" && opts.hoveredAtom >= 0) atomIdxs = [opts.hoveredAtom];
      else if (opts.mode === "chain" && opts.hoveredChain >= 0) atomIdxs = lookups?.atomsByChain[opts.hoveredChain];
      else if (opts.mode === "residue" && opts.hoveredResidue >= 0) atomIdxs = lookups?.atomsByResidue[opts.hoveredResidue];

      if (atomIdxs && atomIdxs.length > 0) {
        for (let k = 0; k < atomIdxs.length; k++) {
          const i = atomIdxs[k]!;
          const r = radii[i]! * opts.radiusScale * scaleMul;
          posRef.current.set(scene.atoms.positions[i * 3]!, scene.atoms.positions[i * 3 + 1]!, scene.atoms.positions[i * 3 + 2]!);
          sRef.current.set(r, r, r);
          mRef.current.compose(posRef.current, qRef.current.identity(), sRef.current);
          atomOverlay.current.setMatrixAt(w++, mRef.current);
        }
      } else {
        if (opts.mode === "chain" && opts.hoveredChain >= 0 && scene.atoms.chainIndex) {
          const ci = scene.atoms.chainIndex;
          for (let i = 0; i < scene.atoms.count; i++) {
            if (ci[i] !== opts.hoveredChain) continue;
            const r = radii[i]! * opts.radiusScale * scaleMul;
            posRef.current.set(scene.atoms.positions[i * 3]!, scene.atoms.positions[i * 3 + 1]!, scene.atoms.positions[i * 3 + 2]!);
            sRef.current.set(r, r, r);
            mRef.current.compose(posRef.current, qRef.current.identity(), sRef.current);
            atomOverlay.current.setMatrixAt(w++, mRef.current);
          }
        } else if (opts.mode === "residue" && opts.hoveredResidue >= 0 && scene.atoms.residueIndex) {
          const ri = scene.atoms.residueIndex;
          for (let i = 0; i < scene.atoms.count; i++) {
            if (ri[i] !== opts.hoveredResidue) continue;
            const r = radii[i]! * opts.radiusScale * scaleMul;
            posRef.current.set(scene.atoms.positions[i * 3]!, scene.atoms.positions[i * 3 + 1]!, scene.atoms.positions[i * 3 + 2]!);
            sRef.current.set(r, r, r);
            mRef.current.compose(posRef.current, qRef.current.identity(), sRef.current);
            atomOverlay.current.setMatrixAt(w++, mRef.current);
          }
        }
      }

      atomOverlay.current.count = w;
      atomOverlay.current.instanceMatrix.needsUpdate = true;
    }

    // Bond overlay update
    if (bondOverlay.current && scene.bonds) {
      const indexA = scene.bonds.indexA;
      const indexB = scene.bonds.indexB;
      let w = 0;

      let bondIdxs: number[] | undefined;
      if (opts.mode === "atom" && opts.hoveredAtom >= 0) bondIdxs = lookups?.bondsByAtom[opts.hoveredAtom];
      else if (opts.mode === "chain" && opts.hoveredChain >= 0) bondIdxs = lookups?.bondsByChain[opts.hoveredChain];
      else if (opts.mode === "residue" && opts.hoveredResidue >= 0) bondIdxs = lookups?.bondsByResidue[opts.hoveredResidue];

      if (bondIdxs && bondIdxs.length > 0) {
        for (let k = 0; k < bondIdxs.length; k++) {
          const i = bondIdxs[k]!;
          const ia = indexA[i]!;
          const ib = indexB[i]!;
          aRef.current.set(scene.atoms.positions[ia * 3]!, scene.atoms.positions[ia * 3 + 1]!, scene.atoms.positions[ia * 3 + 2]!);
          bRef.current.set(scene.atoms.positions[ib * 3]!, scene.atoms.positions[ib * 3 + 1]!, scene.atoms.positions[ib * 3 + 2]!);
          dirRef.current.subVectors(bRef.current, aRef.current);
          const len = dirRef.current.length();
          if (len <= 1e-6) continue;
          dirRef.current.normalize();
          qRef.current.setFromUnitVectors(upRef.current, dirRef.current);
          posRef.current.addVectors(aRef.current, bRef.current).multiplyScalar(0.5);
          mRef.current.compose(posRef.current, qRef.current, new Vector3(1, len, 1));
          bondOverlay.current.setMatrixAt(w++, mRef.current);
        }
      } else {
        const chainIndex = scene.atoms.chainIndex;
        const residueIndex = scene.atoms.residueIndex;
        for (let i = 0; i < scene.bonds.count; i++) {
          const ia = indexA[i]!;
          const ib = indexB[i]!;
          const match = (opts.mode === "atom" && opts.hoveredAtom >= 0 && (ia === opts.hoveredAtom || ib === opts.hoveredAtom))
            || (opts.mode === "chain" && opts.hoveredChain >= 0 && chainIndex && (chainIndex[ia] === opts.hoveredChain || chainIndex[ib] === opts.hoveredChain))
            || (opts.mode === "residue" && opts.hoveredResidue >= 0 && residueIndex && (residueIndex[ia] === opts.hoveredResidue || residueIndex[ib] === opts.hoveredResidue));
          if (!match) continue;
          aRef.current.set(scene.atoms.positions[ia * 3]!, scene.atoms.positions[ia * 3 + 1]!, scene.atoms.positions[ia * 3 + 2]!);
          bRef.current.set(scene.atoms.positions[ib * 3]!, scene.atoms.positions[ib * 3 + 1]!, scene.atoms.positions[ib * 3 + 2]!);
          dirRef.current.subVectors(bRef.current, aRef.current);
          const len = dirRef.current.length();
          if (len <= 1e-6) continue;
          dirRef.current.normalize();
          qRef.current.setFromUnitVectors(upRef.current, dirRef.current);
          posRef.current.addVectors(aRef.current, bRef.current).multiplyScalar(0.5);
          mRef.current.compose(posRef.current, qRef.current, new Vector3(1, len, 1));
          bondOverlay.current.setMatrixAt(w++, mRef.current);
        }
      }
      bondOverlay.current.count = w;
      bondOverlay.current.instanceMatrix.needsUpdate = true;
    }
  }, [scene, opts.mode, opts.hoveredAtom, opts.hoveredResidue, opts.hoveredChain, opts.radiusScale, opts.scale, lookups]);

  return { atomOverlay: atomOverlay.current, bondOverlay: bondOverlay.current };
}
