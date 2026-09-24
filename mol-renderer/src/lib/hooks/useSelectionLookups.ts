/*
 Title: useSelectionLookups
 Description: Builds lookup tables (atoms/bonds by residue/chain/atom) from a MolScene to enable
 efficient selection and hover overlays. Memoized per scene instance.
 Each table is compact (all members in one Uint32Array, grouped by key, plus offsets): one JS array per
 atom would take gigabytes of heap for structures with millions of atoms.
*/
import { useMemo } from "react";
import type { MolScene } from "pdb-parser";

/** Members of key k are `items[offsets[k] .. offsets[k + 1])`. */
export class Groups {
  readonly offsets: Uint32Array;
  readonly items: Uint32Array;
  constructor(offsets: Uint32Array, items: Uint32Array) { this.offsets = offsets; this.items = items; }
  static readonly empty = new Groups(new Uint32Array(1), new Uint32Array(0));
  /** Members of key k (empty when k is out of range). */
  of(k: number): Uint32Array {
    if (!(k >= 0 && k + 1 < this.offsets.length)) return this.items.subarray(0, 0);
    return this.items.subarray(this.offsets[k]!, this.offsets[k + 1]!);
  }
}

export type SelectionLookups = {
  atomsByResidue: Groups;
  atomsByChain: Groups;
  bondsByAtom: Groups;
  bondsByResidue: Groups;
  bondsByChain: Groups;
};

/** Groups `n` items into `keys` groups; `keysOf(i, emit)` emits each key item i belongs to (in a stable order). */
function group(n: number, keys: number, keysOf: (i: number, emit: (k: number) => void) => void): Groups {
  const offsets = new Uint32Array(keys + 1);
  for (let i = 0; i < n; i++) keysOf(i, (k) => { if (k >= 0 && k < keys) offsets[k + 1]!++; });
  for (let k = 0; k < keys; k++) offsets[k + 1]! += offsets[k]!;
  const items = new Uint32Array(offsets[keys]!);
  const cursor = offsets.slice(0, keys);
  for (let i = 0; i < n; i++) keysOf(i, (k) => { if (k >= 0 && k < keys) items[cursor[k]!++] = i; });
  return new Groups(offsets, items);
}

export function useSelectionLookups(scene: MolScene | null): SelectionLookups {
  return useMemo(() => {
    if (!scene) {
      return {
        atomsByResidue: Groups.empty,
        atomsByChain: Groups.empty,
        bondsByAtom: Groups.empty,
        bondsByResidue: Groups.empty,
        bondsByChain: Groups.empty,
      };
    }

    const atomCount = scene.atoms?.count ?? 0;

    const ri = scene.atoms.residueIndex as (number[] | Uint32Array | undefined);
    const ci = scene.atoms.chainIndex as (number[] | Uint32Array | undefined);

    let residues = 0;
    let chains = 0;
    if (ri && atomCount > 0) {
      for (let i = 0; i < atomCount; i++) if (ri[i]! + 1 > residues) residues = (ri[i]! + 1);
    }
    if (ci && atomCount > 0) {
      for (let i = 0; i < atomCount; i++) if (ci[i]! + 1 > chains) chains = (ci[i]! + 1);
    }

    const atomsByResidue = ri ? group(atomCount, residues, (i, emit) => emit(ri[i]!)) : Groups.empty;
    const atomsByChain = ci ? group(atomCount, chains, (i, emit) => emit(ci[i]!)) : Groups.empty;

    const bondCount = scene.bonds?.count ?? 0;
    const indexA = scene.bonds?.indexA as (number[] | Uint32Array | undefined);
    const indexB = scene.bonds?.indexB as (number[] | Uint32Array | undefined);
    if (bondCount === 0 || !indexA || !indexB) {
      return { atomsByResidue, atomsByChain, bondsByAtom: Groups.empty, bondsByResidue: Groups.empty, bondsByChain: Groups.empty };
    }

    const bondsByAtom = group(bondCount, atomCount, (i, emit) => { emit(indexA[i]!); emit(indexB[i]!); });
    // A bond within one residue (or chain) is listed once
    const bondsByResidue = ri
      ? group(bondCount, residues, (i, emit) => { const ra = ri[indexA[i]!]!, rb = ri[indexB[i]!]!; emit(ra); if (rb !== ra) emit(rb); })
      : Groups.empty;
    const bondsByChain = ci
      ? group(bondCount, chains, (i, emit) => { const ca = ci[indexA[i]!]!, cb = ci[indexB[i]!]!; emit(ca); if (cb !== ca) emit(cb); })
      : Groups.empty;

    return { atomsByResidue, atomsByChain, bondsByAtom, bondsByResidue, bondsByChain };
  }, [scene]);
}
