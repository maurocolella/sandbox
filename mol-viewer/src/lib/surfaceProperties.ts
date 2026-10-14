/*
 Title: surfaceProperties
 Description: Per-atom properties for colouring molecular surfaces:
 - Charges: formal charges at pH 7 on the charged groups (Asp, Glu -1; Lys, Arg +1; His neutral; chain
   termini; nucleic-acid phosphates -1; metal ions +2, Na/K +1), spread evenly over the group's atoms.
   Ligand charges are unknown and left at 0.
 - Hydrophobicity: Eisenberg consensus scale per amino acid (as PyMOL's color_h), coloured from dark cyan
   (hydrophilic) through white to goldenrod (hydrophobic), as ChimeraX does; other residues are uncoloured.
*/
import type { MolScene } from "pdb-parser";
import { Color, SRGBColorSpace } from "three";

const SIDE_CHAIN_CHARGES: Record<string, Record<string, number>> = {
  ASP: { OD1: -0.5, OD2: -0.5 },
  GLU: { OE1: -0.5, OE2: -0.5 },
  LYS: { NZ: 1 },
  ARG: { NE: 1 / 3, NH1: 1 / 3, NH2: 1 / 3 },
};
const PHOSPHATE: Record<string, number> = { OP1: -0.5, OP2: -0.5, O1P: -0.5, O2P: -0.5 };
// Atomic number -> ion charge
const ION_CHARGES: Record<number, number> = { 11: 1, 19: 1, 12: 2, 20: 2, 25: 2, 26: 2, 27: 2, 28: 2, 29: 2, 30: 2 };

/** Charge of each atom (e), by scene atom index. */
export function atomCharges(scene: MolScene): Float32Array {
  const n = scene.atoms.count, out = new Float32Array(n);
  const names = scene.atoms.names, E = scene.atoms.element, ri = scene.atoms.residueIndex;
  const residues = scene.tables?.residues ?? [];
  if (!names || !ri) return out;
  const polymer = new Uint8Array(residues.length), nTerm = new Uint8Array(residues.length);
  for (const seg of scene.tables?.chainSegments ?? []) {
    for (let r = seg.startResidue; r <= seg.endResidue; r++) polymer[r] = 1;
    nTerm[seg.startResidue] = 1;
  }
  const cTerm = new Uint8Array(residues.length);
  for (let i = 0; i < n; i++) if (names[i] === "OXT") cTerm[ri[i]!] = 1;
  for (let i = 0; i < n; i++) {
    const r = ri[i]!, name = names[i]!, res = residues[r]?.name ?? "";
    if (!polymer[r]) { out[i] = ION_CHARGES[E?.[i] ?? 0] ?? 0; continue; }
    let q = SIDE_CHAIN_CHARGES[res]?.[name] ?? PHOSPHATE[name] ?? 0;
    if (nTerm[r] && name === "N") q += 1;
    if (cTerm[r] && (name === "O" || name === "OXT")) q -= 0.5;
    out[i] = q;
  }
  return out;
}

// Eisenberg consensus, normalised (Eisenberg et al. 1984)
const EISENBERG: Record<string, number> = {
  ILE: 1.38, PHE: 1.19, VAL: 1.08, LEU: 1.06, TRP: 0.81, MET: 0.64, ALA: 0.62, GLY: 0.48, CYS: 0.29, TYR: 0.26,
  PRO: 0.12, THR: -0.05, SER: -0.18, HIS: -0.4, GLU: -0.74, ASN: -0.78, GLN: -0.85, ASP: -0.9, LYS: -1.5, ARG: -2.53,
};
// sRGB components, blended in sRGB so mid-scale values stay visible
const HYDROPHILIC = [0, 0x8b, 0x8b], MIDDLE = [0xff, 0xff, 0xff], HYDROPHOBIC = [0xb8, 0x86, 0x0b];

/** Linear RGB per scene atom by its residue's hydrophobicity (r = -1 for non-amino-acid atoms). */
export function hydrophobicityColors(scene: MolScene): Float32Array {
  const n = scene.atoms.count, out = new Float32Array(n * 3).fill(-1);
  const ri = scene.atoms.residueIndex, residues = scene.tables?.residues ?? [];
  if (!ri) return out;
  const c = new Color();
  for (let i = 0; i < n; i++) {
    const h = EISENBERG[residues[ri[i]!]?.name ?? ""];
    if (h === undefined) continue;
    // Saturates at ±1.5: Arg's -2.53 would otherwise wash out the rest of the scale
    const t = Math.max(-1, Math.min(1, h / 1.5));
    const end = t < 0 ? HYDROPHILIC : HYDROPHOBIC, u = Math.abs(t);
    c.setRGB(...([0, 1, 2].map((k) => (MIDDLE[k]! + (end[k]! - MIDDLE[k]!) * u) / 255) as [number, number, number]), SRGBColorSpace);
    out[i * 3] = c.r; out[i * 3 + 1] = c.g; out[i * 3 + 2] = c.b;
  }
  return out;
}
