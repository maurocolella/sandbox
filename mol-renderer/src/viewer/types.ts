export type RenderRepresentation = "spheres" | "ribbon-tube" | "ribbon-flat";

import type { InstancedMesh, Object3D, LineSegments, Mesh } from "three";

export interface RenderObjects {
  atoms?: InstancedMesh;
  bonds?: Object3D;
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
  sphereDetail: number;
}

export interface OverlayControls {
  mode: "atom" | "residue" | "chain";
  hoverTint: string;
  onTopHighlight: boolean;
}
