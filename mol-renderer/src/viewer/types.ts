export type RenderRepresentation = "spheres" | "ribbon-tube" | "ribbon-flat";

import type { Object3D, LineSegments, Mesh } from "three";
import type { LodInstances } from "../lib/instancedLod";

export interface RenderObjects {
  atoms?: LodInstances;
  bonds?: LodInstances;
  backbone?: LineSegments;
  ribbon?: Object3D;
  surface?: Mesh;
}

export interface RenderControls {
  renderMode: "spheres" | "ribbon-tube" | "ribbon-flat";
  showAtoms: boolean;
  showBonds: boolean;
  showBackbone: boolean;
  radiusScale: number;
}

export interface OverlayControls {
  mode: "atom" | "residue" | "chain";
  hoverTint: string;
  onTopHighlight: boolean;
}
