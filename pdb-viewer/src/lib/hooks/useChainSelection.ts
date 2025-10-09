import { useEffect, useMemo, useState } from "react";
import type { MolScene } from "pdb-parser";

export interface ChainSelection {
  chainSelected: Record<number, boolean>;
  setChainSelected: (next: Record<number, boolean>) => void;
  selectedChainIndices: number[];
  chains: { index: number; id: string }[];
}

export function useChainSelection(scene: MolScene | null): ChainSelection {
  const [chainSelected, setChainSelectedState] = useState<Record<number, boolean>>({});

  useEffect(() => {
    if (!scene?.tables?.chains) {
      setChainSelectedState({});
      return;
    }
    const next: Record<number, boolean> = {};
    for (let i = 0; i < scene.tables.chains.length; i++) next[i] = true;
    setChainSelectedState(next);
  }, [scene]);

  const chains = useMemo(() => {
    const list: { index: number; id: string }[] = [];
    if (!scene?.tables?.chains) return list;
    for (let i = 0; i < scene.tables.chains.length; i++) {
      list.push({ index: i, id: scene.tables.chains[i]!.id });
    }
    return list;
  }, [scene]);

  const selectedChainIndices = useMemo(() => {
    return Object.entries(chainSelected)
      .filter(([, v]) => v !== false)
      .map(([k]) => Number(k))
      .sort((a, b) => a - b);
  }, [chainSelected]);

  const setChainSelected = (next: Record<number, boolean>) => setChainSelectedState(next);

  return { chainSelected, setChainSelected, selectedChainIndices, chains };
}
