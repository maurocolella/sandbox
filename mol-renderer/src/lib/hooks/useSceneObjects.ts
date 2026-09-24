/*
 Title: useSceneObjects
 Description: Builds js scene objects (atoms, bonds, backbone) from a MolScene based on options,
 configures materials/geometry for viewer needs, and ensures proper disposal when options change.
 Atom and bond instance data is built in workers (one each, in parallel); the previous objects stay until
 the new ones are ready. `status` reports each build's progress, then "upload" until `drawn` is called
 for it (after the first frame that draws it).
*/
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MolScene, AtomMeshOptions, BackboneLineOptions } from "pdb-parser";
import { makeBackboneLines } from "pdb-parser";
import { FrontSide, MeshStandardMaterial, type LineSegments, type Material } from "three";
import { createLodAtoms, createLodBonds } from "../lodAtoms";
import type { LodBuildProgress, LodInstances } from "../instancedLod";
import { SceneBuildClient } from "../sceneBuild";

export interface SceneBuildOptions {
  atoms: AtomMeshOptions | false;
  bonds: boolean;
  backbone: BackboneLineOptions | false;
}

export type SceneBuildKind = "atoms" | "bonds";
/** A build's progress, or "upload" once its data is on the way to the GPU. */
export type SceneBuildStatus = { kind: SceneBuildKind; stage: LodBuildProgress["stage"] | "upload"; done?: number; total?: number };

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** One instance set built in a worker: the current set, and its build status. */
function useWorkerSet(kind: SceneBuildKind, request: ((client: SceneBuildClient, onProgress: (p: LodBuildProgress) => void) => Promise<LodInstances>) | null) {
  const [set, setSet] = useState<LodInstances | undefined>(undefined);
  const [status, setStatus] = useState<SceneBuildStatus | null>(null);
  const [client] = useState(() => new SceneBuildClient());

  useEffect(() => () => client.dispose(), [client]);
  useEffect(() => {
    if (!request) { client.cancel(); setSet(undefined); setStatus(null); return; }
    let cancelled = false;
    setStatus({ kind, stage: "instances" }); // until the worker's first progress message
    request(client, (p) => { if (!cancelled) setStatus({ kind, ...p }); })
      .then((next) => {
        if (cancelled) { next.dispose(); return; }
        setSet(next);
        setStatus({ kind, stage: "upload" });
      })
      .catch((e) => {
        if (isAbort(e)) return;
        console.error(`Building ${kind} failed`, e);
        if (!cancelled) setStatus(null);
      });
    return () => { cancelled = true; };
  }, [client, kind, request]);
  // The previous set is disposed once replaced (or on unmount)
  useEffect(() => () => set?.dispose(), [set]);

  const drawn = useCallback(() => setStatus((s) => (s?.stage === "upload" ? null : s)), []);
  return { set, status, drawn };
}

export function useSceneObjects(scene: MolScene | null, opts: SceneBuildOptions) {
  const radiusScale = opts.atoms === false ? null : opts.atoms?.radiusScale ?? 1.0;
  const atomRequest = useMemo(() => {
    if (!scene || radiusScale === null) return null;
    return (client: SceneBuildClient, onProgress: (p: LodBuildProgress) => void) => client.build("atoms", {
      count: scene.atoms.count,
      positions: scene.atoms.positions,
      radii: scene.atoms.radii,
      colors: scene.atoms.colors,
      radiusScale,
    }, onProgress).then((data) => createLodAtoms(data, new MeshStandardMaterial({ color: 0xffffff, metalness: 0, roughness: 0.5, side: FrontSide })));
  }, [scene, radiusScale]);
  const bondRequest = useMemo(() => {
    const bonds = scene?.bonds;
    if (!scene || !opts.bonds || !bonds || bonds.count === 0) return null;
    return (client: SceneBuildClient, onProgress: (p: LodBuildProgress) => void) => client.build("bonds", {
      count: bonds.count,
      indexA: bonds.indexA,
      indexB: bonds.indexB,
      positions: scene.atoms.positions,
      radius: 0.06,
    }, onProgress).then((data) => createLodBonds(data, new MeshStandardMaterial({ color: 0xaaaaaa, metalness: 0, roughness: 0.5, side: FrontSide })));
  }, [scene, opts.bonds]);

  const atoms = useWorkerSet("atoms", atomRequest);
  const bonds = useWorkerSet("bonds", bondRequest);

  const backbone = useMemo(() => {
    if (!scene || opts.backbone === false) return undefined;
    const lines = makeBackboneLines(scene, { color: opts.backbone?.color ?? 0xffffff }) as LineSegments | undefined;
    if (lines) {
      const mat = lines.material as unknown as { side?: number; needsUpdate?: boolean };
      if (typeof mat.side !== "undefined") mat.side = FrontSide;
      if (typeof mat.needsUpdate !== "undefined") mat.needsUpdate = true;
    }
    return lines;
  }, [scene, opts.backbone]);
  useEffect(() => () => {
    backbone?.geometry.dispose();
    (backbone?.material as Material | undefined)?.dispose?.();
  }, [backbone]);

  return {
    atoms: atoms.set,
    bonds: bonds.set,
    backbone,
    /** Atoms first while both are in progress. */
    status: atoms.status ?? bonds.status,
    atomsDrawn: atoms.drawn,
    bondsDrawn: bonds.drawn,
  };
}
