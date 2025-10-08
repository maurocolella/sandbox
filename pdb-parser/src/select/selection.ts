import type { MolScene } from "../types/molScene.js";
import { elementSymbolFromCode } from "../utils/elements.js";

/**
 * Metadata for a selected atom, suitable for hover tooltips and UI labels.
 */
export interface AtomSelection {
  atomIndex: number;
  serial?: number;
  name?: string;
  element?: string;
  chain?: { index: number; id: string };
  residue?: { index: number; name: string; seq: number; iCode?: string };
}

/**
 * Maps an InstancedMesh instanceId (atom instance index) to rich metadata.
 * @param scene MolScene with typed arrays populated by the parser
 * @param instanceId InstancedMesh instance index (0..atoms.count-1)
 * @returns AtomSelection or null if out of range
 */
export function getAtomSelection(scene: MolScene, instanceId: number): AtomSelection | null {
  const aCount = scene.atoms.count;
  if (instanceId < 0 || instanceId >= aCount) return null;

  const serial = scene.atoms.serial ? scene.atoms.serial[instanceId] : undefined;
  const name = scene.atoms.names ? scene.atoms.names[instanceId] : undefined;

  let element: string | undefined = undefined;
  if (scene.atoms.element) {
    const code = scene.atoms.element[instanceId];
    element = elementSymbolFromCode(code);
  }

  let chain: AtomSelection["chain"] = undefined;
  if (scene.atoms.chainIndex && scene.tables?.chains) {
    const ci = scene.atoms.chainIndex[instanceId];
    const c = scene.tables.chains[ci];
    if (c) chain = { index: ci, id: c.id };
  }

  let residue: AtomSelection["residue"] = undefined;
  if (scene.atoms.residueIndex && scene.tables?.residues) {
    const ri = scene.atoms.residueIndex[instanceId];
    const r = scene.tables.residues[ri];
    if (r) residue = { index: ri, name: r.name, seq: r.seq, iCode: r.iCode };
  }

  return { atomIndex: instanceId, serial, name, element, chain, residue };
}

/**
 * Bond selection payload for a line segment in a bonds LineSegments object.
 */
export interface BondSelection {
  bondIndex: number;
  a: AtomSelection;
  b: AtomSelection;
  order?: number;
}

/**
 * Maps a bond line segment index to its atom selections (endpoints) and order.
 * @param scene MolScene with bonds
 * @param segmentIndex index in bonds.indexA/indexB arrays
 * @returns BondSelection or null if out of range or bonds missing
 */
export function getBondSelection(scene: MolScene, segmentIndex: number): BondSelection | null {
  const bonds = scene.bonds;
  if (!bonds) return null;
  if (segmentIndex < 0 || segmentIndex >= bonds.count) return null;
  const ia = bonds.indexA[segmentIndex];
  const ib = bonds.indexB[segmentIndex];
  const a = getAtomSelection(scene, ia);
  const b = getAtomSelection(scene, ib);
  if (!a || !b) return null;
  const ord = bonds.order ? bonds.order[segmentIndex] : undefined;
  return { bondIndex: segmentIndex, a, b, order: ord };
}

/**
 * Formats a short label for an atom selection (e.g., for tooltips).
 * @param sel AtomSelection to label
 */
export function formatAtomLabel(sel: AtomSelection): string {
  const chain = sel.chain ? sel.chain.id : "";
  const res = sel.residue ? `${sel.residue.name} ${sel.residue.seq}${sel.residue.iCode || ""}` : "";
  const atom = sel.name || "";
  const el = sel.element || "";
  const ser = sel.serial != null ? `#${sel.serial}` : "";
  return [chain, res, atom, el, ser].filter(Boolean).join(" · ");
}
