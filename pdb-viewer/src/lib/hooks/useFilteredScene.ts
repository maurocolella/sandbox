import { useMemo } from "react";
import type { MolScene } from "pdb-parser";
import { subsetMolSceneByChains } from "pdb-parser";

export function useFilteredScene(scene: MolScene | null, selectedChainIndices: number[]): { filtered: MolScene | null; selectionKey: string } {
  const selectionKey = useMemo(() => selectedChainIndices.join("-"), [selectedChainIndices]);

  const filtered = useMemo<MolScene | null>(() => {
    if (!scene) return null;
    const chains = scene.tables?.chains ?? [];
    if (chains.length === 0) return scene;
    if (selectedChainIndices.length === 0) return subsetMolSceneByChains(scene, []);
    if (selectedChainIndices.length === chains.length) return scene;
    return subsetMolSceneByChains(scene, selectedChainIndices);
  }, [scene, selectedChainIndices]);

  return { filtered, selectionKey };
}
