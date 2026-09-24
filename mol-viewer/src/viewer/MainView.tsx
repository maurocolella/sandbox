import { Suspense, useCallback, useMemo, useState, useEffect, useRef } from "react";
import type { MolScene } from "pdb-parser";
import { useMolScene } from "../lib/hooks/useMolScene";
import { useRendererControls } from "../lib/hooks/useRendererControls";
import { useChainSelection } from "../lib/hooks/useChainSelection";
import { useFilteredScene } from "mol-renderer";
import { MoleculeRender } from "mol-renderer";
import type { RenderControls, OverlayControls, SurfaceData, RenderStatsInfo } from "mol-renderer";
import { SurfaceWorkerClient, type Atom } from "chem-surface";
import SurfaceWorker from "chem-surface/worker?worker";

const SOLVENT = new Set(["HOH", "WAT", "DOD", "H2O"]);
import { Leva } from "leva";
import { StructureControls } from "./StructureControls";
import { resolveStructureSource, type StructureSource } from "../lib/structureSource";

const INITIAL_SOURCE = "3J2T";

export function MainView() {
  // Raw text in the field; the structure loads once it resolves (PDB ID, URL or path) and typing pauses
  const [sourceInput, setSourceInput] = useState<string>(INITIAL_SOURCE);
  const [source, setSource] = useState<StructureSource>(() => resolveStructureSource(INITIAL_SOURCE)!);
  const pending = useMemo(() => resolveStructureSource(sourceInput), [sourceInput]);
  useEffect(() => {
    if (!pending || pending.url === source.url) return;
    const t = setTimeout(() => setSource(pending), 350);
    return () => clearTimeout(t);
  }, [pending, source.url]);

  const { parseOpts, display, style, spheres, selection, surface } = useRendererControls();

  const parseOptions = useMemo(() => ({
    altLocPolicy: parseOpts.altLocPolicy,
    bondPolicy: parseOpts.bondPolicy,
    ...(parseOpts.useModelSelection ? { modelSelection: parseOpts.modelSelection as number } : {}),
  }), [parseOpts]);

  const { scene, error, loading } = useMolScene(source.url, parseOptions, source.fallbackUrl);
  const sourceError = error && source.pdbId && /\b404\b/.test(error)
    ? `No entry ${source.pdbId} on RCSB.`
    : error;
  const sourceHint = pending?.pdbId ? `RCSB entry ${pending.pdbId}` : undefined;

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

  const [surfaceData, setSurfaceData] = useState<SurfaceData | null>(null);
  const [renderStats, setRenderStats] = useState<RenderStatsInfo | null>(null);
  // Surfaces are generated in a worker; a new request supersedes (terminates) the one in flight
  const surfaceClient = useRef<SurfaceWorkerClient | null>(null);
  useEffect(() => {
    const client = new SurfaceWorkerClient(() => new SurfaceWorker());
    surfaceClient.current = client;
    return () => { client.dispose(); surfaceClient.current = null; };
  }, []);

  const atomsInput = useMemo<Atom[]>(() => {
    const s = filteredScene;
    const n = s?.atoms?.count ?? 0;
    if (!s || n === 0) return [];
    const out: Atom[] = [];
    const pos = s.atoms.positions as Float32Array;
    const rad = s.atoms.radii as Float32Array;
    const residues = s.tables?.residues;
    const residueIndex = s.atoms.residueIndex;
    for (let i = 0; i < n; i++) {
      // Solvent is left out of surfaces, as in PyMOL
      if (residues && residueIndex && SOLVENT.has(residues[residueIndex[i]!]?.name ?? "")) continue;
      const j = i * 3;
      out.push({ x: pos[j], y: pos[j + 1], z: pos[j + 2], radius: rad[i] });
    }
    return out;
  }, [filteredScene]);

  // The previous surface stays on screen until the new one arrives; only disabling clears it
  useEffect(() => {
    const client = surfaceClient.current;
    if (!surface.enabled || atomsInput.length === 0 || !client) { client?.cancel(); setSurfaceData(null); return; }
    let cancelled = false;
    client.generate(surface.kind, atomsInput, { probeRadius: surface.probeRadius, voxelSize: surface.voxelSize })
      .then((geom) => { if (!cancelled) setSurfaceData(geom); })
      .catch((e) => { if (!(e instanceof DOMException && e.name === "AbortError")) console.error("Surface generation failed", e); });
    return () => { cancelled = true; };
  }, [atomsInput, surface.enabled, surface.kind, surface.probeRadius, surface.voxelSize]);

  const renderControls = useMemo<RenderControls>(() => ({
    renderMode: display.representation as "spheres" | "ribbon-tube" | "ribbon-flat",
    showAtoms: display.atoms,
    showBonds: display.bonds,
    showBackbone: display.backbone,
    radiusScale: spheres.radiusScale,
  }), [display.representation, display.atoms, display.bonds, display.backbone, spheres.radiusScale]);

  const overlayControls = useMemo<OverlayControls>(() => ({
    mode: (selection.mode === "none" ? "atom" : selection.mode) as "atom" | "residue" | "chain",
    hoverTint: selection.hoverTint,
    onTopHighlight: selection.onTopHighlight,
  }), [selection.mode, selection.hoverTint, selection.onTopHighlight]);

  const atomCount = filteredScene?.atoms?.count ?? 0;
  const bondCount = filteredScene?.bonds?.count ?? 0;

  return (
    <div style={{ display: 'flex', height: '100%', flex: 1 }}>
      <Leva collapsed={false} oneLineLabels hideCopyButton />
      <div className="absolute top-3 left-3 z-10 w-96">
        <StructureControls
          scene={scene as MolScene | null}
          sourceInput={sourceInput}
          onSourceInputChange={setSourceInput}
          hint={sourceHint}
          error={sourceError}
          chainSelected={chainSelected}
          onToggleChain={handleChainCheckbox}
          onAllChains={handleAllChains}
          onNoChains={handleNoChains}
        />
      </div>
      <div style={{ width: "100%", height: "100%" }}>
        <Suspense fallback={null}>
          <MoleculeRender
            scene={scene}
            background={style.background}
            renderControls={renderControls}
            overlayControls={overlayControls}
            visibleChains={selectedChainIndices}
            surfaceData={surfaceData}
            surfaceWireframe={surface.wireframe}
            surfaceOpacity={surface.opacity}
            onRenderStats={setRenderStats}
            stats={display.fps ? { className: "fixed bottom-3 left-44 z-20 opacity-70" } : false}
            continuousRender={display.continuousRender}
          />
        </Suspense>
      </div>
      {!loading && filteredScene && (
        <div className="absolute bottom-3 left-3 z-10">
          <div className="rounded-lg bg-zinc-900/80 p-3 text-zinc-200 backdrop-blur">
            <div className="mb-1 text-sm font-semibold">Model</div>
            <div className="text-xs">Atoms: {atomCount.toLocaleString()}</div>
            <div className="text-xs">Bonds: {bondCount.toLocaleString()}</div>
            {renderStats && <div className="text-xs">Triangles: {renderStats.triangles.toLocaleString()}</div>}
            {renderStats && <div className="text-xs">Draw calls: {renderStats.drawCalls.toLocaleString()}</div>}
          </div>
        </div>
      )}
      {loading && (
        <div style={{ position: "absolute", left: 12, bottom: 12, color: "#ccc", fontFamily: "monospace", fontSize: 12 }}>
          Loading…
        </div>
      )}
    </div>
  );
}
