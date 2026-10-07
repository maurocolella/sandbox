/*
 Title: useRendererControls
 Description: Leva controls for the viewer's floating windows (parsing, surface, and styling with its scene,
 spheres and selection sections), one store per window so each renders in its own panel. Everyday toggles (representation,
 visibility, selection mode, surface on/off) live in the side column, not here. `reset` restores a
 window's defaults.
*/
import { folder, useControls, useCreateStore } from "leva";
import type { ParseOptions } from "pdb-parser";

type Store = ReturnType<typeof useCreateStore>;
export type ControlWindow = "parsing" | "surface" | "styling";

const PARSING_DEFAULTS = { altLocPolicy: "occupancy", bondPolicy: "conect+heuristic", useModelSelection: false, modelSelection: 1 };
const SURFACE_DEFAULTS = { kind: "ses", probeRadius: 1.4, voxelSize: 0.5, wireframe: false, opacity: 1 };
const STYLING_DEFAULTS = { background: "#111111", radiusScale: 0.3, hoverTint: "#ff00ff", onTopHighlight: true };

export interface RendererControls {
  stores: Record<ControlWindow, Store>;
  reset: Record<ControlWindow, () => void>;
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
  };

  // Function schemas, for their setters (used by reset)
  const [parseOpts, setParsing] = useControls(() => ({
    altLocPolicy: { value: PARSING_DEFAULTS.altLocPolicy, options: ["occupancy", "all"] as ParseOptions["altLocPolicy"][] },
    bondPolicy: {
      value: PARSING_DEFAULTS.bondPolicy,
      options: ["conect-only", "heuristic-if-missing", "conect+heuristic"] as ParseOptions["bondPolicy"][],
    },
    useModelSelection: { value: PARSING_DEFAULTS.useModelSelection },
    modelSelection: { value: PARSING_DEFAULTS.modelSelection, min: 1, step: 1, render: (get) => Boolean(get("useModelSelection")) },
  }), { store: stores.parsing });

  const [surface, setSurface] = useControls(() => ({
    kind: { value: SURFACE_DEFAULTS.kind, options: ["vdw", "sas", "ses"] },
    probeRadius: { value: SURFACE_DEFAULTS.probeRadius, min: 0.5, max: 3.0, step: 0.1 },
    voxelSize: { value: SURFACE_DEFAULTS.voxelSize, min: 0.25, max: 2.0, step: 0.05 },
    wireframe: { value: SURFACE_DEFAULTS.wireframe },
    opacity: { value: SURFACE_DEFAULTS.opacity, min: 0.05, max: 1, step: 0.05 },
  }), { store: stores.surface });

  const [styling, setStyling] = useControls(() => ({
    Scene: folder({ background: { value: STYLING_DEFAULTS.background } }),
    Spheres: folder({ radiusScale: { value: STYLING_DEFAULTS.radiusScale, min: 0.05, max: 2.0, step: 0.05 } }),
    Selection: folder({
      hoverTint: { value: STYLING_DEFAULTS.hoverTint },
      onTopHighlight: { value: STYLING_DEFAULTS.onTopHighlight },
    }),
  }), { store: stores.styling });

  return {
    stores,
    reset: {
      parsing: () => setParsing(PARSING_DEFAULTS),
      surface: () => setSurface(SURFACE_DEFAULTS),
      styling: () => setStyling(STYLING_DEFAULTS),
    },
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
    style: { background: String(styling.background) },
    spheres: { radiusScale: Number(styling.radiusScale) },
    selection: { hoverTint: String(styling.hoverTint), onTopHighlight: Boolean(styling.onTopHighlight) },
  };
}
