/*
 Title: useRendererControls
 Description: Leva controls for the viewer's floating windows (parsing, surface, styling, spheres, selection
 highlight), one store per window so each renders in its own panel. Everyday toggles (representation,
 visibility, selection mode, surface on/off) live in the side column, not here. `reset` restores a
 window's defaults.
*/
import { useControls, useCreateStore } from "leva";
import type { ParseOptions } from "pdb-parser";

type Store = ReturnType<typeof useCreateStore>;
export type ControlWindow = "parsing" | "surface" | "styling" | "spheres" | "selection";

const PARSING_DEFAULTS = { altLocPolicy: "occupancy", bondPolicy: "conect+heuristic", useModelSelection: false, modelSelection: 1 };
const SURFACE_DEFAULTS = { kind: "ses", probeRadius: 1.4, voxelSize: 0.5, wireframe: false, opacity: 1 };
const STYLING_DEFAULTS = { background: "#111111" };
const SPHERES_DEFAULTS = { radiusScale: 0.3 };
const SELECTION_DEFAULTS = { hoverTint: "#ff00ff", onTopHighlight: true };

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
    spheres: useCreateStore(),
    selection: useCreateStore(),
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

  const [style, setStyling] = useControls(() => ({ background: { value: STYLING_DEFAULTS.background } }), { store: stores.styling });

  const [spheres, setSpheres] = useControls(() => ({ radiusScale: { value: SPHERES_DEFAULTS.radiusScale, min: 0.05, max: 2.0, step: 0.05 } }), { store: stores.spheres });

  const [selection, setSelection] = useControls(() => ({
    hoverTint: { value: SELECTION_DEFAULTS.hoverTint },
    onTopHighlight: { value: SELECTION_DEFAULTS.onTopHighlight },
  }), { store: stores.selection });

  return {
    stores,
    reset: {
      parsing: () => setParsing(PARSING_DEFAULTS),
      surface: () => setSurface(SURFACE_DEFAULTS),
      styling: () => setStyling(STYLING_DEFAULTS),
      spheres: () => setSpheres(SPHERES_DEFAULTS),
      selection: () => setSelection(SELECTION_DEFAULTS),
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
    style: { background: String(style.background) },
    spheres: { radiusScale: Number(spheres.radiusScale) },
    selection: { hoverTint: String(selection.hoverTint), onTopHighlight: Boolean(selection.onTopHighlight) },
  };
}
