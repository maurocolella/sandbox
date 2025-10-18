/*
 Title: useSceneObjects
 Description: Builds js scene objects (atoms, bonds, backbone) from a MolScene based on options,
 configures materials/geometry for viewer needs, and ensures proper disposal when options change.
*/
import { useEffect, useMemo } from "react";
import type { MolScene, AtomMeshOptions, BackboneLineOptions } from "pdb-parser";
import { makeAtomsMesh, makeBackboneLines, makeBondTubes } from "pdb-parser";
import { BufferGeometry, CylinderGeometry, FrontSide, Object3D, type InstancedMesh as InstancedMeshType, type LineSegments, type Material } from "three";

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
        if (typeof mat.side !== "undefined") mat.side = FrontSide;
        if (typeof mat.needsUpdate !== "undefined") mat.needsUpdate = true;

        // Attach minimal lookups needed by a renderer-only overlay implementation.
        const ci = scene.atoms.chainIndex ? new Uint32Array(scene.atoms.chainIndex) : undefined;
        const ri = scene.atoms.residueIndex ? new Uint32Array(scene.atoms.residueIndex) : undefined;
        (atoms as unknown as Object3D & { userData: { chainIndex?: Uint32Array; residueIndex?: Uint32Array; positions?: Float32Array; radii?: Float32Array; count?: number; bbox?: { min: [number, number, number]; max: [number, number, number] }; radiusScale?: number } }).userData = {
          ...(atoms.userData as Record<string, unknown>),
          ...(ci ? { chainIndex: ci } : {}),
          ...(ri ? { residueIndex: ri } : {}),
          positions: scene.atoms.positions,
          radii: scene.atoms.radii,
          count: scene.atoms.count,
          ...(scene.bbox ? { bbox: { min: scene.bbox.min, max: scene.bbox.max } } : {}),
          radiusScale: opts.atoms?.radiusScale ?? 1.0,
        } as unknown as { chainIndex?: Uint32Array; residueIndex?: Uint32Array; positions?: Float32Array; radii?: Float32Array; count?: number; bbox?: { min: [number, number, number]; max: [number, number, number] }; radiusScale?: number };

        atoms.frustumCulled = false;
      }
    }
    if (opts.bonds) {
      bonds = makeBondTubes(scene) as InstancedMeshType | undefined;
      if (bonds) {
        // Replace base geometry with a simpler 8-sided cylinder (unit height, Y-up)
        const oldGeom = bonds.geometry;
        const radius = 0.06; // keep close to existing tube radius used elsewhere
        const simple = new CylinderGeometry(radius, radius, 1, 8, 1, false);
        bonds.geometry = simple as unknown as BufferGeometry;
        oldGeom.dispose();
        const mat = bonds.material as unknown as { side?: number; needsUpdate?: boolean };
        if (typeof mat.side !== "undefined") mat.side = FrontSide;
        if (typeof mat.needsUpdate !== "undefined") mat.needsUpdate = true;

        if (scene.bonds && scene.bonds.count > 0) {
          const indexA = scene.bonds.indexA as ArrayLike<number>;
          const indexB = scene.bonds.indexB as ArrayLike<number>;
          const endpoints = { a: new Uint32Array(indexA), b: new Uint32Array(indexB) };
          (bonds as Object3D & { userData: { endpoints?: { a: Uint32Array; b: Uint32Array } } }).userData = {
            ...(bonds.userData as Record<string, unknown>),
            endpoints,
          } as { endpoints?: { a: Uint32Array; b: Uint32Array } } as unknown as Record<string, unknown>;
        }
        (bonds as Object3D).frustumCulled = false;
      }
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
