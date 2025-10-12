/*
 Title: useRibbonGroup
 Description: Builds either a tubular ribbon or a flat ribbon mesh group from a MolScene
 using pdb-parser helpers, enforces front-side materials, and disposes resources on change.
*/
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { MolScene, AtomMeshOptions } from "pdb-parser";
import { makeRibbonMesh, makeFlatRibbonMesh } from "pdb-parser";

export interface RibbonParams {
  thickness?: number; // for flat ribbon
}

export function useRibbonGroup(
  scene: MolScene | null,
  representation: "spheres" | "ribbon-tube" | "ribbon-flat",
  materialKind: AtomMeshOptions["materialKind"],
  params: RibbonParams
): THREE.Group | null {
  const group = useMemo(() => {
    if (!scene) return null;
    if (representation === "ribbon-tube") {
      return makeRibbonMesh(scene, {
        radius: 0.4,
        radialSegments: 12,
        tubularSegmentsPerPoint: 6,
        materialKind,
        color: 0xffffff,
      });
    }
    if (representation === "ribbon-flat") {
      return makeFlatRibbonMesh(scene, {
        width: 1.2,
        segmentsPerPoint: 6,
        materialKind,
        color: 0xffffff,
        doubleSided: false,
        thickness: params.thickness,
      });
    }
    return null;
  }, [scene, representation, materialKind, params.thickness]);

  // Force front-side materials on all ribbon meshes
  useEffect(() => {
    if (!group) return;
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const m = obj.material as THREE.Material | THREE.Material[];
        if (Array.isArray(m)) {
          m.forEach((mm) => { mm.side = THREE.FrontSide; mm.needsUpdate = true; });
        } else {
          m.side = THREE.FrontSide;
          m.needsUpdate = true;
        }
      }
    });
  }, [group]);

  // Dispose on change/unmount
  useEffect(() => {
    return () => {
      if (!group) return;
      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const m = obj.material as THREE.Material | THREE.Material[];
          if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
          else m.dispose();
        }
      });
    };
  }, [group]);

  return group;
}
