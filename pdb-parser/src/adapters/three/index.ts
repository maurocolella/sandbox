export { makeAtomsMesh, type AtomMeshOptions } from "./atoms.js";
export { makeBondLines, type BondLineOptions } from "./bonds.js";
export { makeBackboneLines, type BackboneLineOptions } from "./backbone.js";
export { makeRibbonMesh, type RibbonOptions } from "./ribbon.js";
export { makeFlatRibbonMesh, type FlatRibbonOptions } from "./ribbon.js";

import type { MolScene } from "../../types/molScene.js";
import type { AtomMeshOptions } from "./atoms.js";
import type { BondLineOptions } from "./bonds.js";
import type { BackboneLineOptions } from "./backbone.js";
import { makeAtomsMesh } from "./atoms.js";
import { makeBondLines } from "./bonds.js";
import { makeBackboneLines } from "./backbone.js";
import * as THREE from "three";

export interface SceneObjectsOptions {
  atoms?: AtomMeshOptions | false;
  bonds?: BondLineOptions | false;
  backbone?: BackboneLineOptions | false;
}

export interface SceneObjects {
  atoms?: THREE.InstancedMesh;
  bonds?: THREE.LineSegments;
  backbone?: THREE.LineSegments;
}

// Small convenience that composes individual builders without hiding behavior.
export function makeSceneObjects(scene: MolScene, opts: SceneObjectsOptions = {}): SceneObjects {
  const out: SceneObjects = {};
  if (opts.atoms !== false) out.atoms = makeAtomsMesh(scene, opts.atoms || {});
  if (opts.bonds !== false) out.bonds = makeBondLines(scene, opts.bonds || {});
  if (opts.backbone !== false) out.backbone = makeBackboneLines(scene, opts.backbone || {});
  return out;
}
