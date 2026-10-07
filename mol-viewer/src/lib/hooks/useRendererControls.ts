/*
 Title: useRendererControls
 Description: Leva controls for the viewer's floating windows (parsing, surface, styling, spheres, selection
 highlight), one store per window so each renders in its own panel. Everyday toggles (representation,
 visibility, selection mode, surface on/off) live in the side column, not here.
*/
import { useControls, useCreateStore } from "leva";
import type { ParseOptions } from "pdb-parser";

type Store = ReturnType<typeof useCreateStore>;

export interface RendererControls {
  stores: { parsing: Store; surface: Store; styling: Store; spheres: Store; selection: Store };
  parseOpts: {
    altLocPolicy: ParseOptions["altLocPolicy"];
    bondPolicy: ParseOptions["bondPolicy"];
    useModelSelection: boolean;
    modelSelection: number;
  };
  surface: {
    kind: "vdw" | "sas" | "ses";
    probeRadius: number;
    voxelSize: number;
    wireframe: boolean;
    opacity: number;
  };
  style: { background: string };
  spheres: { radiusScale: number };
  selection: { hoverTint: string; onTopHighlight: boolean };
}

export function useRendererControls(): RendererControls {
  const stores = {
    parsing: useCreateStore(),
    surface: useCreateStore(),
    styling: useCreateStore(),
    spheres: useCreateStore(),
    selection: useCreateStore(),
  };

  const parseOpts = useControls({
    altLocPolicy: { value: "occupancy", options: ["occupancy", "all"] as ParseOptions["altLocPolicy"][] },
    bondPolicy: {
      value: "conect+heuristic",
      options: ["conect-only", "heuristic-if-missing", "conect+heuristic"] as ParseOptions["bondPolicy"][],
    },
    useModelSelection: { value: false },
    modelSelection: { value: 1, min: 1, step: 1, render: (get) => Boolean(get("useModelSelection")) },
  }, { store: stores.parsing });

  const surface = useControls({
    kind: { value: "ses", options: ["vdw", "sas", "ses"] as const },
    probeRadius: { value: 1.4, min: 0.5, max: 3.0, step: 0.1 },
    voxelSize: { value: 0.5, min: 0.25, max: 2.0, step: 0.05 },
    wireframe: { value: false },
    opacity: { value: 1, min: 0.05, max: 1, step: 0.05 },
  }, { store: stores.surface });

  const style = useControls({ background: { value: "#111111" } }, { store: stores.styling });

  const spheres = useControls({ radiusScale: { value: 0.3, min: 0.05, max: 2.0, step: 0.05 } }, { store: stores.spheres });

  const selection = useControls({
    hoverTint: { value: "#ff00ff" },
    onTopHighlight: { value: true },
  }, { store: stores.selection });

  return {
    stores,
    parseOpts: {
      altLocPolicy: parseOpts.altLocPolicy as ParseOptions["altLocPolicy"],
      bondPolicy: parseOpts.bondPolicy as ParseOptions["bondPolicy"],
      useModelSelection: Boolean(parseOpts.useModelSelection),
      modelSelection: Number(parseOpts.modelSelection),
    },
    surface: {
      kind: surface.kind as "vdw" | "sas" | "ses",
      probeRadius: Number(surface.probeRadius),
      voxelSize: Number(surface.voxelSize),
      wireframe: Boolean(surface.wireframe),
      opacity: Number(surface.opacity),
    },
    style: { background: String(style.background) },
    spheres: { radiusScale: Number(spheres.radiusScale) },
    selection: { hoverTint: String(selection.hoverTint), onTopHighlight: Boolean(selection.onTopHighlight) },
  };
}
