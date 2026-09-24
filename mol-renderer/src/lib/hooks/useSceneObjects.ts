/*
 Title: useSceneObjects
 Description: Builds js scene objects (atoms, bonds, backbone) from a MolScene based on options,
 configures materials/geometry for viewer needs, and ensures proper disposal when options change.
*/
import { useEffect, useMemo } from "react";
import type { MolScene, AtomMeshOptions, BackboneLineOptions } from "pdb-parser";
import { makeBackboneLines } from "pdb-parser";
import { FrontSide, MeshStandardMaterial, type LineSegments, type Material } from "three";
import { buildLodAtoms, buildLodBonds } from "../lodAtoms";
import type { LodInstances } from "../instancedLod";

export interface SceneBuildOptions {
  atoms: AtomMeshOptions | false;
  bonds: boolean;
  backbone: BackboneLineOptions | false;
}

export function useSceneObjects(scene: MolScene | null, opts: SceneBuildOptions) {
  const objects = useMemo(() => {
    if (!scene) return { atoms: undefined as LodInstances | undefined, bonds: undefined as LodInstances | undefined, backbone: undefined as LineSegments | undefined };

    let atoms: LodInstances | undefined;
    let bonds: LodInstances | undefined;
    let backbone: LineSegments | undefined;

    if (opts.atoms !== false) {
      const material = new MeshStandardMaterial({ color: 0xffffff, metalness: 0, roughness: 0.5, side: FrontSide });
      atoms = buildLodAtoms({
        count: scene.atoms.count,
        positions: scene.atoms.positions,
        radii: scene.atoms.radii,
        colors: scene.atoms.colors,
        radiusScale: opts.atoms?.radiusScale ?? 1.0,
        material,
      });
    }
    if (opts.bonds && scene.bonds && scene.bonds.count > 0) {
      bonds = buildLodBonds({
        count: scene.bonds.count,
        indexA: scene.bonds.indexA,
        indexB: scene.bonds.indexB,
        positions: scene.atoms.positions,
        radius: 0.06,
        material: new MeshStandardMaterial({ color: 0xaaaaaa, metalness: 0, roughness: 0.5, side: FrontSide }),
      });
    }
    if (opts.backbone !== false) {
      backbone = makeBackboneLines(scene, { color: opts.backbone?.color ?? 0xffffff }) as LineSegments | undefined;
      if (backbone) {
        const mat = backbone.material as unknown as { side?: number; needsUpdate?: boolean };
        if (typeof mat.side !== "undefined") mat.side = FrontSide;
        if (typeof mat.needsUpdate !== "undefined") mat.needsUpdate = true;
      }
    }

    return { atoms, bonds, backbone };
  }, [scene, opts.atoms, opts.bonds, opts.backbone]);

  useEffect(() => {
    return () => {
      objects.atoms?.dispose();
      objects.bonds?.dispose();
      objects.backbone?.geometry.dispose();
      (objects.backbone?.material as Material | undefined)?.dispose?.();
    };
  }, [objects.atoms, objects.bonds, objects.backbone]);

  return objects;
}
