/*
 Title: depict
 Description: 2D depiction of a ligand from its own 3D atoms and bond orders (heavy atoms only), with RDKit
 (WebAssembly, loaded on first use) computing the 2D layout and implicit hydrogens. Atoms keep their scene
 index, so 3D interactions map onto the drawing.
*/
import type { MolScene } from "pdb-parser";
import { elementSymbolFromCode } from "pdb-parser";
import { ligandAtoms, type LigandRef } from "mol-renderer";
import wasmUrl from "@rdkit/rdkit/RDKit_minimal.wasm?url";

export interface Depiction {
  atoms: { el: string; x: number; y: number; hs: number; charge: number; scene: number }[];
  bonds: { a: number; b: number; order: number }[];
}

type RDKitModule = Awaited<ReturnType<typeof import("@rdkit/rdkit").default>>;
let rdkit: Promise<RDKitModule> | null = null;
const loadRDKit = () => (rdkit ??= import("@rdkit/rdkit").then(({ default: init }) => init({ locateFile: () => wasmUrl })));

const col = (v: number | string, w: number) => String(v).padStart(w);
const symbol = (code: number) => elementSymbolFromCode(code) ?? "C";

export async function depictLigand(scene: MolScene, ligand: LigandRef): Promise<Depiction | null> {
  const E = scene.atoms.element, P = scene.atoms.positions, b = scene.bonds;
  const atoms = ligandAtoms(scene, ligand).filter((i) => E?.[i] !== 1);
  if (atoms.length < 2 || !E) return null;
  const local = new Map(atoms.map((a, k) => [a, k]));
  const bonds: Depiction["bonds"] = [];
  for (let k = 0; b && k < b.count; k++) {
    const x = local.get(b.indexA[k]!), y = local.get(b.indexB[k]!);
    if (x !== undefined && y !== undefined) bonds.push({ a: x, b: y, order: b.order?.[k] ?? 1 });
  }
  const molblock = [
    "", "  mol-viewer", "",
    `${col(atoms.length, 3)}${col(bonds.length, 3)}  0  0  0  0  0  0  0  0999 V2000`,
    ...atoms.map((i) => `${col(P[i * 3]!.toFixed(4), 10)}${col(P[i * 3 + 1]!.toFixed(4), 10)}${col(P[i * 3 + 2]!.toFixed(4), 10)} ${symbol(E[i]!).padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`),
    ...bonds.map((bd) => `${col(bd.a + 1, 3)}${col(bd.b + 1, 3)}${col(Math.min(3, bd.order), 3)}  0`),
    "M  END",
  ].join("\n");

  const RDKit = await loadRDKit();
  // Without hydrogens or charges some valences don't sanitize (e.g. a protonated amine); lay those out as given
  let mol = RDKit.get_mol(molblock, JSON.stringify({ removeHs: false }));
  if (!mol?.is_valid()) { mol?.delete(); mol = RDKit.get_mol(molblock, JSON.stringify({ sanitize: false, removeHs: false })); }
  if (!mol) return null;
  try {
    mol.set_new_coords(true);
    mol.normalize_depiction();
    mol.straighten_depiction();
    const m = JSON.parse(mol.get_json()).molecules[0];
    const coords: [number, number][] = m.conformers?.find((c: { dim: number }) => c.dim === 2)?.coords ?? [];
    if (coords.length !== atoms.length) return null;
    return {
      atoms: atoms.map((i, k) => ({
        el: symbol(E[i]!), x: coords[k]![0], y: -coords[k]![1], // SVG y points down
        hs: m.atoms[k]?.impHs ?? 0, charge: m.atoms[k]?.chg ?? 0, scene: i,
      })),
      bonds,
    };
  } finally {
    mol.delete();
  }
}
