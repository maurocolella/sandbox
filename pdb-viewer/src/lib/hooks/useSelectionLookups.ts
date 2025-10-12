import { useMemo } from "react";
import type { MolScene } from "pdb-parser";

export type SelectionLookups = {
  atomsByResidue: number[][];
  atomsByChain: number[][];
  bondsByAtom: number[][];
  bondsByResidue: number[][];
  bondsByChain: number[][];
};

export function useSelectionLookups(scene: MolScene | null): SelectionLookups {
  return useMemo(() => {
    if (!scene) {
      return {
        atomsByResidue: [],
        atomsByChain: [],
        bondsByAtom: [],
        bondsByResidue: [],
        bondsByChain: [],
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

    const atomsByResidue: number[][] = Array.from({ length: residues }, () => []);
    const atomsByChain: number[][] = Array.from({ length: chains }, () => []);

    if (atomCount > 0) {
      for (let i = 0; i < atomCount; i++) {
        if (ri) atomsByResidue[ri[i] as number]?.push(i);
        if (ci) atomsByChain[ci[i] as number]?.push(i);
      }
    }

    const bondCount = scene.bonds?.count ?? 0;
    const indexA = scene.bonds?.indexA as (number[] | Uint32Array | undefined);
    const indexB = scene.bonds?.indexB as (number[] | Uint32Array | undefined);

    const bondsByAtom: number[][] = Array.from({ length: atomCount }, () => []);
    const bondsByResidue: number[][] = Array.from({ length: residues }, () => []);
    const bondsByChain: number[][] = Array.from({ length: chains }, () => []);

    if (bondCount > 0 && indexA && indexB) {
      for (let i = 0; i < bondCount; i++) {
        const a = indexA[i]!;
        const b = indexB[i]!;
        if (a >= 0 && a < atomCount) bondsByAtom[a].push(i);
        if (b >= 0 && b < atomCount) bondsByAtom[b].push(i);
        if (ri) {
          const ra = ri[a] as number; const rb = ri[b] as number;
          if (ra >= 0 && ra < residues) bondsByResidue[ra].push(i);
          if (rb >= 0 && rb < residues && rb !== ra) bondsByResidue[rb].push(i);
        }
        if (ci) {
          const ca = ci[a] as number; const cb = ci[b] as number;
          if (ca >= 0 && ca < chains) bondsByChain[ca].push(i);
          if (cb >= 0 && cb < chains && cb !== ca) bondsByChain[cb].push(i);
        }
      }
    }

    return { atomsByResidue, atomsByChain, bondsByAtom, bondsByResidue, bondsByChain };
  }, [scene]);
}
