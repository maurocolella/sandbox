import { useEffect, useMemo } from "react";
import type { MolScene, AtomMeshOptions, BackboneLineOptions } from "pdb-parser";
import { makeAtomsMesh, makeBackboneLines, makeBondTubes } from "pdb-parser";
import type { InstancedMesh as InstancedMeshType, LineSegments, Material } from "three";

export interface SceneBuildOptions {
  atoms: AtomMeshOptions | false;
  bonds: boolean;
  backbone: BackboneLineOptions | false;
}

export function useSceneObjects(scene: MolScene | null, opts: SceneBuildOptions) {
  const objects = useMemo(() => {
    if (!scene) return { atoms: undefined as InstancedMeshType | undefined, bonds: undefined as InstancedMeshType | LineSegments | undefined, backbone: undefined as LineSegments | undefined };

    let atoms: InstancedMeshType | undefined;
    let bonds: InstancedMeshType | LineSegments | undefined;
    let backbone: LineSegments | undefined;

    if (opts.atoms !== false) {
      atoms = makeAtomsMesh(scene, {
        sphereDetail: opts.atoms?.sphereDetail ?? 16,
        materialKind: (opts.atoms?.materialKind ?? "standard") as AtomMeshOptions["materialKind"],
        radiusScale: opts.atoms?.radiusScale ?? 1.0,
      });
      // Uniform white material (disable vertex colors) to keep look consistent with current viewer.
      if (atoms) {
        const mat = atoms.material as unknown as { vertexColors?: boolean; color?: { set: (v: string) => void }; needsUpdate?: boolean };
        if (typeof mat.vertexColors !== "undefined") mat.vertexColors = false;
        if (mat.color) mat.color.set("#ffffff");
        if (typeof mat.needsUpdate !== "undefined") mat.needsUpdate = true;
      }
    }
    if (opts.bonds) {
      bonds = makeBondTubes(scene) as InstancedMeshType | undefined;
    }
    if (opts.backbone !== false) {
      backbone = makeBackboneLines(scene, { color: opts.backbone?.color ?? 0xffffff }) as LineSegments | undefined;
    }

    return { atoms, bonds, backbone };
  }, [scene, opts.atoms, opts.bonds, opts.backbone]);

  useEffect(() => {
    return () => {
      objects.atoms?.geometry.dispose();
      (objects.atoms?.material as Material | undefined)?.dispose?.();
      objects.bonds?.geometry.dispose();
      (objects.bonds?.material as Material | undefined)?.dispose?.();
      objects.backbone?.geometry.dispose();
      (objects.backbone?.material as Material | undefined)?.dispose?.();
    };
  }, [objects.atoms, objects.bonds, objects.backbone]);

  return objects;
}
