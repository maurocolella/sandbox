export type RenderRepresentation = "spheres" | "ribbon-tube" | "ribbon-flat";

import type { Object3D, LineSegments, Mesh } from "three";
import type { ChunkedInstances } from "../lib/chunked";

export interface RenderObjects {
  atoms?: ChunkedInstances;
  bonds?: ChunkedInstances;
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
  /** Upper bound on atom + bond triangles per frame (level of detail keeps within it; 60% atoms, 40% bonds). */
  sphereTriangleBudget: number;
}

export interface OverlayControls {
  mode: "atom" | "residue" | "chain";
  hoverTint: string;
  onTopHighlight: boolean;
}
