import { Suspense, useCallback, useMemo, useState } from "react";
import type { MolScene } from "pdb-parser";
import { useMolScene } from "../lib/hooks/useMolScene";
import { useRendererControls } from "../lib/hooks/useRendererControls";
import { useChainSelection } from "../lib/hooks/useChainSelection";
import { useFilteredScene } from "../lib/hooks/useFilteredScene";
import { MoleculeRender } from "./MoleculeRender";
import type { RenderRepresentation } from "./types";
import { Leva } from "leva";
import { StructureControls } from "./StructureControls";

export function MainView() {
  const [sourceUrl, setSourceUrl] = useState<string>("/models/1IGY.pdb");

  const { parseOpts, display, style, spheres, selection } = useRendererControls();

  const parseOptions = useMemo(() => ({
    altLocPolicy: parseOpts.altLocPolicy,
    bondPolicy: parseOpts.bondPolicy,
    ...(parseOpts.useModelSelection ? { modelSelection: parseOpts.modelSelection as number } : {}),
  }), [parseOpts]);

  const { scene, error, loading } = useMolScene(sourceUrl, parseOptions);

  const { chainSelected, setChainSelected, selectedChainIndices } = useChainSelection(scene as MolScene | null);

  const handleChainCheckbox = useCallback((idx: number, checked: boolean) => {
    setChainSelected({ ...chainSelected, [idx]: checked });
  }, [chainSelected, setChainSelected]);

  const handleAllChains = useCallback(() => {
    if (!scene?.tables?.chains) return;
    const next: Record<number, boolean> = {};
    for (let i = 0; i < scene.tables.chains.length; i++) next[i] = true;
    setChainSelected(next);
  }, [scene, setChainSelected]);

  const handleNoChains = useCallback(() => {
    if (!scene?.tables?.chains) return;
    const next: Record<number, boolean> = {};
    for (let i = 0; i < scene.tables.chains.length; i++) next[i] = false;
    setChainSelected(next);
  }, [scene, setChainSelected]);

  const { filtered: filteredScene } = useFilteredScene(scene as MolScene | null, selectedChainIndices);

  const overlay = useMemo(() => ({
    mode: (selection.mode === "none" ? "atom" : selection.mode) as "atom" | "residue" | "chain",
    hoverTint: selection.hoverTint,
    onTopHighlight: selection.onTopHighlight,
    radiusScale: spheres.radiusScale,
    sphereDetail: spheres.sphereDetail,
  }), [selection.mode, selection.hoverTint, selection.onTopHighlight, spheres.radiusScale, spheres.sphereDetail]);

  const atomCount = filteredScene?.atoms?.count ?? 0;
  const bondCount = filteredScene?.bonds?.count ?? 0;

  return (
    <div style={{ display: 'flex', height: '100%', flex: 1 }}>
      <Leva collapsed={false} oneLineLabels hideCopyButton />
      <div className="absolute top-3 left-3 z-10 w-96">
        <StructureControls
          scene={scene as MolScene | null}
          sourceUrl={sourceUrl}
          onSourceUrlChange={setSourceUrl}
          chainSelected={chainSelected}
          onToggleChain={handleChainCheckbox}
          onAllChains={handleAllChains}
          onNoChains={handleNoChains}
        />
      </div>
      <div style={{ width: "100%", height: "100%" }}>
        <Suspense fallback={null}>
          <MoleculeRender
            background={style.background}
            representation={display.representation as RenderRepresentation}
            showAtoms={display.atoms}
            showBonds={display.bonds}
            showBackbone={display.backbone}
            overlay={overlay}
            scene={scene}
            visibleChains={selectedChainIndices}
          />
        </Suspense>
      </div>
      {!loading && filteredScene && (
        <div className="absolute bottom-3 left-3 z-10">
          <div className="rounded-lg bg-zinc-900/80 p-3 text-zinc-200 backdrop-blur">
            <div className="mb-1 text-sm font-semibold">Model</div>
            <div className="text-xs">Atoms: {atomCount.toLocaleString()}</div>
            <div className="text-xs">Bonds: {bondCount.toLocaleString()}</div>
          </div>
        </div>
      )}
      {loading && (
        <div style={{ position: "absolute", left: 12, bottom: 12, color: "#ccc", fontFamily: "monospace", fontSize: 12 }}>
          Loading…
        </div>
      )}
      {error && (
        <div style={{ position: "absolute", left: 12, bottom: 12, color: "#f88", fontFamily: "monospace", fontSize: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}
