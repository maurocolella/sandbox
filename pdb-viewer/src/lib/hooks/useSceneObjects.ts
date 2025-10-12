import { useEffect, useMemo } from "react";
import type { MolScene, AtomMeshOptions, BackboneLineOptions } from "pdb-parser";
import { makeAtomsMesh, makeBackboneLines, makeBondTubes } from "pdb-parser";
import * as THREE from "three";
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
        const mat = atoms.material as unknown as { vertexColors?: boolean; color?: { set: (v: string) => void }; side?: number; needsUpdate?: boolean };
        if (typeof mat.vertexColors !== "undefined") mat.vertexColors = false;
        if (mat.color) mat.color.set("#ffffff");
        // Widen effective pickable surface near silhouettes
        if (typeof mat.side !== "undefined") mat.side = THREE.FrontSide;
        if (typeof mat.needsUpdate !== "undefined") mat.needsUpdate = true;

        const count = scene.atoms.count;
        const instanceToAtom = new Uint32Array(count);
        for (let i = 0; i < count; i++) instanceToAtom[i] = i;
        (atoms as THREE.Object3D & { userData: { instanceToAtom?: Uint32Array } }).userData = {
          ...(atoms.userData as Record<string, unknown>),
          instanceToAtom,
        } as { instanceToAtom?: Uint32Array } as unknown as Record<string, unknown>;
        atoms.frustumCulled = false;
      }
    }
    if (opts.bonds) {
      bonds = makeBondTubes(scene) as InstancedMeshType | undefined;
      if (bonds) {
        // Replace base geometry with a simpler 8-sided cylinder (unit height, Y-up)
        const oldGeom = bonds.geometry;
        const radius = 0.06; // keep close to existing tube radius used elsewhere
        const simple = new THREE.CylinderGeometry(radius, radius, 1, 8, 1, false);
        bonds.geometry = simple as unknown as THREE.BufferGeometry;
        oldGeom.dispose();
        const mat = bonds.material as unknown as { side?: number; needsUpdate?: boolean };
        if (typeof mat.side !== "undefined") mat.side = THREE.FrontSide;
        if (typeof mat.needsUpdate !== "undefined") mat.needsUpdate = true;

        if (scene.bonds && scene.bonds.count > 0) {
          const indexA = scene.bonds.indexA as ArrayLike<number>;
          const indexB = scene.bonds.indexB as ArrayLike<number>;
          const endpoints = { a: new Uint32Array(indexA), b: new Uint32Array(indexB) };
          (bonds as THREE.Object3D & { userData: { endpoints?: { a: Uint32Array; b: Uint32Array } } }).userData = {
            ...(bonds.userData as Record<string, unknown>),
            endpoints,
          } as { endpoints?: { a: Uint32Array; b: Uint32Array } } as unknown as Record<string, unknown>;
        }
        (bonds as THREE.Object3D).frustumCulled = false;
      }
    }
    if (opts.backbone !== false) {
      backbone = makeBackboneLines(scene, { color: opts.backbone?.color ?? 0xffffff }) as LineSegments | undefined;
      if (backbone) {
        const mat = backbone.material as unknown as { side?: number; needsUpdate?: boolean };
        if (typeof mat.side !== "undefined") mat.side = THREE.FrontSide;
        if (typeof mat.needsUpdate !== "undefined") mat.needsUpdate = true;
      }
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
