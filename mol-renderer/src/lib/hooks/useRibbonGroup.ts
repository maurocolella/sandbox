/*
 Title: useRibbonGroup
 Description: Builds either a tubular ribbon or a flat ribbon mesh group from a MolScene
 using pdb-parser helpers, enforces front-side materials, and disposes resources on change.
*/
import { useEffect, useMemo, useRef } from "react";
import type { MolScene, AtomMeshOptions } from "pdb-parser";
import { makeRibbonMesh, makeFlatRibbonMesh } from "pdb-parser";
import type { Group, Material } from "three";
import { Mesh, FrontSide } from "three";

export interface RibbonParams {
  thickness?: number; // for flat ribbon
}

// Cache: per scene (identity), store groups keyed by representation/material/thickness (null when backbone absent)
const ribbonCache: WeakMap<MolScene, Map<string, Group | null>> = new WeakMap();

function cacheKey(rep: "ribbon-tube" | "ribbon-flat", materialKind: AtomMeshOptions["materialKind"], thickness?: number) {
  return `${rep}|${materialKind}|${thickness ?? "-"}`;
}

function buildRibbon(
  scene: MolScene,
  rep: "ribbon-tube" | "ribbon-flat",
  materialKind: AtomMeshOptions["materialKind"],
  thickness?: number
): Group | null {
  const group = rep === "ribbon-tube"
    ? makeRibbonMesh(scene, { radius: 0.4, radialSegments: 12, tubularSegmentsPerPoint: 6, materialKind, color: 0xffffff })
    : makeFlatRibbonMesh(scene, { width: 1.2, segmentsPerPoint: 6, materialKind, color: 0xffffff, doubleSided: false, thickness });
  if (!group) return null;
  // Enforce front-side materials
  group.traverse((obj) => {
    if (obj instanceof Mesh) {
      const m = obj.material as Material | Material[];
      if (Array.isArray(m)) m.forEach((mm) => { mm.side = FrontSide; (mm as Material).needsUpdate = true; });
      else { m.side = FrontSide; m.needsUpdate = true; }
    }
  });
  return group;
}

export function useRibbonGroup(
  scene: MolScene | null,
  representation: "spheres" | "ribbon-tube" | "ribbon-flat",
  materialKind: AtomMeshOptions["materialKind"],
  params: RibbonParams
): Group | null {
  const built = useMemo(() => {
    if (!scene) return null;
    if (representation === "spheres") return null;
    let cache = ribbonCache.get(scene);
    if (!cache) { cache = new Map<string, Group | null>(); ribbonCache.set(scene, cache); }
    const key = cacheKey(representation, materialKind, params.thickness);
    const hit = cache.get(key);
    if (hit) return hit;
    const grp = buildRibbon(scene, representation, materialKind, params.thickness);
    cache.set(key, grp);
    return grp;
  }, [scene, representation, materialKind, params.thickness]);

  // Prewarm the other ribbon kind in the background to avoid first-switch lag
  useEffect(() => {
    if (!scene) return;
    // Only prewarm when scene changes or material/thickness changes
    let raf = 0;
    const prewarm = () => {
      let cache = ribbonCache.get(scene);
      if (!cache) { cache = new Map<string, Group | null>(); ribbonCache.set(scene, cache); }
      const otherKinds: ("ribbon-tube" | "ribbon-flat")[] = ["ribbon-tube", "ribbon-flat"];
      for (const rep of otherKinds) {
        const key = cacheKey(rep, materialKind, params.thickness);
        if (!cache.has(key)) {
          const grp = buildRibbon(scene, rep, materialKind, params.thickness);
          cache.set(key, grp);
        }
      }
    };
    if (typeof (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback === "function") {
      (window as unknown as { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback(prewarm);
    } else {
      raf = window.setTimeout(prewarm, 0);
    }
    return () => { if (raf) clearTimeout(raf); };
  }, [scene, materialKind, params.thickness]);

  // Dispose cache for previous scene when scene identity changes
  const prevScene = useRef<MolScene | null>(null);
  useEffect(() => {
    if (prevScene.current && prevScene.current !== scene) {
      const cache = ribbonCache.get(prevScene.current);
      if (cache) {
        for (const grp of cache.values()) {
          if (!grp) continue;
          grp.traverse((obj) => {
            if (obj instanceof Mesh) {
              obj.geometry.dispose();
              const m = obj.material as Material | Material[];
              if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
              else m.dispose();
            }
          });
        }
        cache.clear();
      }
    }
    prevScene.current = scene;
  }, [scene]);

  return built;
}
