/*
 Title: useRendererControls
 Description: Centralizes all Leva control groups for the viewer (parsing, display, styling,
 spheres, ribbon, selection) and exposes a typed, convenient API for MoleculeView and others.
*/
import { useControls } from "leva";
import type { ParseOptions } from "pdb-parser";

export type Representation = "spheres" | "ribbon-tube" | "ribbon-flat";
export type MaterialKind = "basic" | "lambert" | "standard";
export type SelectionMode = "none" | "atom" | "residue" | "chain";

export interface RendererControls {
  parseOpts: {
    altLocPolicy: ParseOptions["altLocPolicy"];
    bondPolicy: ParseOptions["bondPolicy"];
    useModelSelection: boolean;
    modelSelection: number;
  };
  display: {
    representation: Representation;
    atoms: boolean;
    bonds: boolean;
    backbone: boolean;
  };
  surface: {
    enabled: boolean;
    kind: "vdw" | "sas" | "ses";
    probeRadius: number;
    voxelSize: number;
    wireframe: boolean;
  };
  style: {
    materialKind: MaterialKind;
    background: string;
    metalShading: boolean;
  };
  spheres: {
    sphereDetail: number;
    radiusScale: number;
  };
  ribbon: {
    thickness: number;
  };
  selection: {
    mode: SelectionMode;
    hoverTint: string;
    onTopHighlight: boolean;
  };
}

export function useRendererControls(): RendererControls {
  const parseOpts = useControls(
    "Parsing",
    {
      altLocPolicy: { value: "occupancy", options: ["occupancy", "all"] as ParseOptions["altLocPolicy"][] },
      bondPolicy: {
        value: "conect+heuristic",
        options: [
          "conect-only",
          "heuristic-if-missing",
          "conect+heuristic",
        ] as ParseOptions["bondPolicy"][],
      },
      useModelSelection: { value: false },
      modelSelection: {
        value: 1,
        min: 1,
        step: 1,
        render: (get) => Boolean(get("Parsing.useModelSelection")),
      },
    },
    { collapsed: true }
  );

  const display = useControls("Display", {
    representation: { value: "spheres", options: ["spheres", "ribbon-tube", "ribbon-flat"] as const },
    atoms: {
      value: true,
      render: (get) => get("Display.representation") === "spheres",
    },
    bonds: true,
    backbone: {
      value: true,
      render: (get) => get("Display.representation") === "spheres",
    },
  });

  const surface = useControls(
    "Surface",
    {
      enabled: { value: false },
      kind: { value: "vdw", options: ["vdw", "sas", "ses"] as const },
      probeRadius: { value: 1.4, min: 0.5, max: 3.0, step: 0.1 },
      voxelSize: { value: 1.0, min: 0.25, max: 3.0, step: 0.05 },
      wireframe: { value: true },
    },
    { collapsed: true }
  );

  const style = useControls(
    "Styling",
    {
      materialKind: { value: "lambert", options: ["basic", "lambert", "standard"] as const },
      background: { value: "#111111" },
      metalShading: { value: false },
    },
    { collapsed: true }
  );

  const spheres = useControls(
    "Spheres",
    {
      sphereDetail: {
        value: 16,
        min: 4,
        max: 32,
        step: 2,
        render: (get) => get("Display.representation") === "spheres",
      },
      radiusScale: {
        value: 0.3,
        min: 0.05,
        max: 2.0,
        step: 0.05,
        render: (get) => get("Display.representation") === "spheres",
      },
    }
  );

  const ribbon = useControls(
    "Ribbon",
    {
      thickness: {
        value: 0.18,
        min: 0.02,
        max: 0.6,
        step: 0.01,
        render: (get) => get("Display.representation") === "ribbon-flat",
      },
    }
  );

  const selection = useControls("Selection", {
    mode: { value: "residue", options: ["none", "atom", "residue", "chain"] as const },
    hoverTint: { value: "#ff00ff" },
    onTopHighlight: { value: true },
  });

  // Normalize return types to our explicit API
  return {
    parseOpts: {
      altLocPolicy: parseOpts.altLocPolicy as ParseOptions["altLocPolicy"],
      bondPolicy: parseOpts.bondPolicy as ParseOptions["bondPolicy"],
      useModelSelection: Boolean(parseOpts.useModelSelection),
      modelSelection: Number(parseOpts.modelSelection),
    },
    display: {
      representation: display.representation as Representation,
      atoms: Boolean(display.atoms),
      bonds: Boolean(display.bonds),
      backbone: Boolean(display.backbone),
    },
    surface: {
      enabled: Boolean(surface.enabled),
      kind: surface.kind as "vdw" | "sas" | "ses",
      probeRadius: Number(surface.probeRadius),
      voxelSize: Number(surface.voxelSize),
      wireframe: Boolean(surface.wireframe),
    },
    style: {
      materialKind: style.materialKind as MaterialKind,
      background: String(style.background),
      metalShading: Boolean(style.metalShading),
    },
    spheres: {
      sphereDetail: Number(spheres.sphereDetail),
      radiusScale: Number(spheres.radiusScale),
    },
    ribbon: {
      thickness: Number(ribbon.thickness),
    },
    selection: {
      mode: selection.mode as SelectionMode,
      hoverTint: String(selection.hoverTint),
      onTopHighlight: Boolean(selection.onTopHighlight),
    },
  };
}
