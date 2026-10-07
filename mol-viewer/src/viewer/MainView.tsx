import { Suspense, useCallback, useMemo, useState, useEffect, useRef, type ReactNode } from "react";
import type { MolScene } from "pdb-parser";
import { useMolScene } from "../lib/hooks/useMolScene";
import { loadStatusText } from "../lib/loadStatusText";
import { useRendererControls, type ControlWindow } from "../lib/hooks/useRendererControls";
import { useChainSelection } from "../lib/hooks/useChainSelection";
import { usePersistentState } from "../lib/hooks/usePersistentState";
import { useFilteredScene } from "mol-renderer";
import { MoleculeRender } from "mol-renderer";
import type { RenderControls, OverlayControls, SurfaceData, RenderStatsInfo, SceneBuildStatus } from "mol-renderer";
import { SurfaceWorkerClient, type Atom } from "chem-surface";
import SurfaceWorker from "chem-surface/worker?worker";
import { Leva, LevaPanel } from "leva";
import { resolveStructureSource, type StructureSource } from "../lib/structureSource";
import { TopBar } from "./ui/TopBar";
import { SideColumn, type Representation, type SelectionMode } from "./ui/SideColumn";
import { FloatingWindow } from "./ui/FloatingWindow";

const SOLVENT = new Set(["HOH", "WAT", "DOD", "H2O"]);
const INITIAL_SOURCE = "3J2T";

// Leva drawn flat and see-through, so the window's frosting shows
const LEVA_THEME = {
  colors: { elevation1: "transparent", elevation2: "transparent", elevation3: "rgba(255,255,255,0.08)" },
  sizes: { rootWidth: "100%" },
};

type WindowId = "parsing" | "surface" | "styling" | "spheres" | "selection" | "debug";
const WINDOWS: { id: WindowId; label: string }[] = [
  { id: "parsing", label: "Parsing" },
  { id: "surface", label: "Surface" },
  { id: "styling", label: "Styling" },
  { id: "spheres", label: "Spheres" },
  { id: "selection", label: "Selection" },
  { id: "debug", label: "Debug" },
];

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

  const { stores, reset, parseOpts, style, spheres, selection, surface } = useRendererControls();
  const [representation, setRepresentation] = useState<Representation>("spheres");
  const [show, setShow] = useState({ atoms: true, bonds: true, backbone: true });
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("residue");
  const [surfaceOn, setSurfaceOn] = useState(false);
  const [continuousRender, setContinuousRender] = useState(false);
  const [open, setOpen] = usePersistentState<Record<WindowId, boolean>>("mol-viewer:windows", {
    parsing: false, surface: false, styling: false, spheres: false, selection: false, debug: true,
  });
  const toggleWindow = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id as WindowId] }));

  const parseOptions = useMemo(() => ({
    altLocPolicy: parseOpts.altLocPolicy,
    bondPolicy: parseOpts.bondPolicy,
    ...(parseOpts.useModelSelection ? { modelSelection: parseOpts.modelSelection as number } : {}),
  }), [parseOpts.altLocPolicy, parseOpts.bondPolicy, parseOpts.useModelSelection, parseOpts.modelSelection]);

  const { scene, error, loading, status: loadStatus } = useMolScene(source.url, parseOptions, source.fallbackUrl);
  const [buildStatus, setBuildStatus] = useState<SceneBuildStatus | null>(null);
  const sourceError = error && source.pdbId && /\b404\b/.test(error)
    ? `No entry ${source.pdbId} on RCSB.`
    : error;
  const sourceHint = pending?.pdbId ? `RCSB entry ${pending.pdbId}` : undefined;

  const { chainSelected, setChainSelected, selectedChainIndices, chains } = useChainSelection(scene as MolScene | null);

  const handleToggleChain = useCallback((idx: number, visible: boolean) => {
    setChainSelected({ ...chainSelected, [idx]: visible });
  }, [chainSelected, setChainSelected]);

  const setAllChains = useCallback((visible: boolean) => {
    if (!scene?.tables?.chains) return;
    const next: Record<number, boolean> = {};
    for (let i = 0; i < scene.tables.chains.length; i++) next[i] = visible;
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

  // Only while surfaces are on: one object per atom is too much heap for millions of atoms
  const atomsInput = useMemo<Atom[]>(() => {
    const s = filteredScene;
    const n = s?.atoms?.count ?? 0;
    if (!surfaceOn || !s || n === 0) return [];
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
  }, [filteredScene, surfaceOn]);

  // The previous surface stays on screen until the new one arrives; only disabling clears it
  useEffect(() => {
    const client = surfaceClient.current;
    if (!surfaceOn || atomsInput.length === 0 || !client) { client?.cancel(); setSurfaceData(null); return; }
    let cancelled = false;
    client.generate(surface.kind, atomsInput, { probeRadius: surface.probeRadius, voxelSize: surface.voxelSize })
      .then((geom) => { if (!cancelled) setSurfaceData(geom); })
      .catch((e) => { if (!(e instanceof DOMException && e.name === "AbortError")) console.error("Surface generation failed", e); });
    return () => { cancelled = true; };
  }, [atomsInput, surfaceOn, surface.kind, surface.probeRadius, surface.voxelSize]);

  const renderControls = useMemo<RenderControls>(() => ({
    renderMode: representation,
    showAtoms: show.atoms,
    showBonds: show.bonds,
    showBackbone: show.backbone,
    radiusScale: spheres.radiusScale,
  }), [representation, show.atoms, show.bonds, show.backbone, spheres.radiusScale]);

  const overlayControls = useMemo<OverlayControls>(() => ({
    mode: (selectionMode === "none" ? "atom" : selectionMode) as "atom" | "residue" | "chain",
    hoverTint: selection.hoverTint,
    onTopHighlight: selection.onTopHighlight,
  }), [selectionMode, selection.hoverTint, selection.onTopHighlight]);

  // The FPS graph is mounted inside the debug window, once it exists
  const [statsEl, setStatsEl] = useState<HTMLDivElement | null>(null);
  const stats = useMemo(() => (open.debug && statsEl ? { parent: { current: statsEl } } : false as const), [open.debug, statsEl]);

  const atomCount = filteredScene?.atoms?.count ?? 0;
  const bondCount = filteredScene?.bonds?.count ?? 0;
  const status = loading || buildStatus ? loadStatusText(loading ? loadStatus : null, buildStatus) ?? "Loading…" : null;

  // Windows open below the top bar, stacked from the left
  const levaWindow = (id: ControlWindow, title: string, index: number): ReactNode => open[id] && (
    <FloatingWindow key={id} id={id} title={title} width={300} defaultPosition={{ x: 12 + index * 24, y: 68 + index * 24 }} onClose={() => toggleWindow(id)} onReset={reset[id]}>
      <LevaPanel store={stores[id]} fill flat titleBar={false} hideCopyButton oneLineLabels theme={LEVA_THEME} />
    </FloatingWindow>
  );

  return (
    <div className="fixed inset-0">
      <Leva hidden />
      <div className="absolute inset-0">
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
            onBuildStatus={setBuildStatus}
            stats={stats}
            continuousRender={continuousRender}
          />
        </Suspense>
      </div>

      <TopBar
        sourceInput={sourceInput}
        onSourceInputChange={setSourceInput}
        hint={sourceHint}
        error={sourceError}
        title={pending?.url === source.url && !loading ? scene?.metadata?.title : undefined}
        menus={WINDOWS.map((w) => ({ ...w, open: open[w.id] }))}
        onToggleMenu={toggleWindow}
      />

      <SideColumn
        objectName={scene?.metadata?.pdbId ?? source.pdbId}
        chains={chains}
        chainSelected={chainSelected}
        onToggleChain={handleToggleChain}
        onAllChains={() => setAllChains(true)}
        onNoChains={() => setAllChains(false)}
        selectionMode={selectionMode}
        onSelectionMode={setSelectionMode}
        representation={representation}
        onRepresentation={setRepresentation}
        show={show}
        onShow={(key, value) => setShow((s) => ({ ...s, [key]: value }))}
        surface={surfaceOn}
        onSurface={setSurfaceOn}
      />

      {levaWindow("parsing", "Parsing", 0)}
      {levaWindow("surface", "Surface", 1)}
      {levaWindow("styling", "Styling", 2)}
      {levaWindow("spheres", "Spheres", 3)}
      {levaWindow("selection", "Selection", 4)}
      {open.debug && (
        <FloatingWindow id="debug" title="Debug" width={240} defaultPosition={{ x: 12, y: window.innerHeight - 260 }} onClose={() => toggleWindow("debug")}>
          <div ref={setStatsEl} className="mb-2 [&>div]:!relative" />
          <div className="space-y-0.5 font-mono text-xs text-zinc-300">
            <div>Atoms: {atomCount.toLocaleString()}</div>
            <div>Bonds: {bondCount.toLocaleString()}</div>
            {renderStats && <div>Triangles: {renderStats.triangles.toLocaleString()}</div>}
            {renderStats && <div>Draw calls: {renderStats.drawCalls.toLocaleString()}</div>}
            <div className="pt-1 text-zinc-400">{status ?? "Ready"}</div>
          </div>
          <label className="mt-2 flex items-center justify-between text-xs text-zinc-300">
            <span>Render continuously</span>
            <input type="checkbox" className="h-3.5 w-3.5 accent-zinc-300" checked={continuousRender} onChange={(e) => setContinuousRender(e.target.checked)} />
          </label>
        </FloatingWindow>
      )}
    </div>
  );
}
