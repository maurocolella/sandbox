/*
 Title: PathTraceHost
 Description: Inside the Canvas: exposes `start` for path-traced renders of the current view (see
 lib/pathTrace), reading the live scene, camera and orbit target, the structure data for atoms and bonds as
 shown, and the selected ligand's centre as the focus.
*/
import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { MolScene } from "pdb-parser";
import type { PathTraceProgress, PathTraceSettings } from "../lib/pathTrace";
import { ligandAtoms, type LigandKey } from "../lib/interactions";

export type RenderSettings = Omit<PathTraceSettings, "focus" | "height" | "background"> & { background: string };

export interface PathTraceApi {
  /** Starts a render (width set; height follows the view's aspect). Returns a cancel function. */
  start(settings: RenderSettings, onProgress: (p: PathTraceProgress) => void): () => void;
}

interface Props {
  apiRef: React.MutableRefObject<PathTraceApi | null>;
  root: React.RefObject<THREE.Object3D | null>;
  scene: MolScene | null;
  atoms: { radiusScale: number } | null; // drawn as spheres
  bonds: boolean;
  focusLigand: LigandKey | null;
}

export function PathTraceHost({ apiRef, root, scene, atoms, bonds, focusLigand }: Props) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as { target?: THREE.Vector3 } | null;
  const size = useThree((s) => s.size);

  useEffect(() => {
    apiRef.current = {
      start(settings, onProgress) {
        const live = root.current;
        if (!live || !(camera as THREE.PerspectiveCamera).isPerspectiveCamera) return () => {};
        let focus: THREE.Vector3 | null = null;
        if (scene && focusLigand) {
          const idx = ligandAtoms(scene, focusLigand), P = scene.atoms.positions;
          if (idx.length) {
            focus = new THREE.Vector3();
            for (const i of idx) focus.add(new THREE.Vector3(P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!));
            focus.divideScalar(idx.length);
          }
        }
        const target = controls?.target?.clone() ?? new THREE.Vector3();
        const height = Math.round(settings.width * (size.height / Math.max(1, size.width)));
        // The tracer loads on first use
        let cancel: (() => void) | null = null, cancelled = false;
        void import("../lib/pathTrace").then(({ startPathTrace }) => {
          if (cancelled) return;
          cancel = startPathTrace(live, camera as THREE.PerspectiveCamera, target, {
            atoms: atoms && scene ? { ...scene.atoms, radiusScale: atoms.radiusScale } : null,
            bonds: bonds && scene?.bonds ? { ...scene.bonds, positions: scene.atoms.positions } : null,
          }, { ...settings, height, focus }, onProgress);
        });
        return () => { cancelled = true; cancel?.(); };
      },
    };
    return () => { apiRef.current = null; };
  }, [apiRef, root, camera, controls, size, scene, atoms, bonds, focusLigand]);

  return null;
}
