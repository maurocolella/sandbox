import { Color } from "three";
import { Suspense, useCallback, useMemo, useState, useEffect, useRef, type ReactNode } from "react";
import type { MolScene } from "pdb-parser";
import { useMolScene } from "../lib/hooks/useMolScene";
import { loadStatusText } from "../lib/loadStatusText";
import { useRendererControls, DEFAULT_BACKGROUND, RENDER_RESOLUTIONS, type ControlWindow } from "../lib/hooks/useRendererControls";
import { useTheme } from "../lib/hooks/useTheme";
import { useChainSelection } from "../lib/hooks/useChainSelection";
import { usePersistentState } from "../lib/hooks/usePersistentState";
import { useFilteredScene, findInteractions } from "mol-renderer";
import { MoleculeRender } from "mol-renderer";
import type { RenderControls, OverlayControls, SurfaceData, RenderStatsInfo, SceneBuildStatus, PocketMesh, LigandRef, SwapMolecule, PathTraceApi, PathTraceProgress } from "mol-renderer";
import { RenderPreview } from "./ui/RenderPreview";
import { SurfaceStreamClient, type Atom } from "chem-surface";
import type { Camera } from "three";
import SurfaceWorker from "chem-surface/worker?worker";
import { Leva, LevaPanel } from "leva";
import { resolveStructureSource, type StructureSource } from "../lib/structureSource";
import { TopBar } from "./ui/TopBar";
import { SideColumn, type Representation, type SelectionMode } from "./ui/SideColumn";
import { FloatingWindow } from "./ui/FloatingWindow";
import { LigandCard, type SwapState } from "./ui/LigandCard";
import { conformer3D, type Candidate } from "../lib/candidates";
import { atomCharges, hydrophobicityColors } from "../lib/surfaceProperties";
import { alignOntoLigand } from "../lib/align";

const SOLVENT = new Set(["HOH", "WAT", "DOD", "H2O"]);

// Pocket score (0..1, buriedness and size) to colour: sky, indigo, then pink from 0.5 up
const POCKET_STOPS = [[0, 0x38bdf8], [0.25, 0x818cf8], [0.5, 0xf472b6]] as const;
// kcal/(mol·e) at full red or blue, as ChimeraX's coulombic default
const POTENTIAL_RANGE = 10;

function pocketColor(score: number): number {
  const t = Math.min(Math.max(score, 0), POCKET_STOPS[POCKET_STOPS.length - 1]![0]);
  for (let i = 1; i < POCKET_STOPS.length; i++) {
    const [t1, c1] = POCKET_STOPS[i]!, [t0, c0] = POCKET_STOPS[i - 1]!;
    if (t > t1) continue;
    const u = (t - t0) / (t1 - t0);
    const mix = (shift: number) => Math.round(((c0 >> shift) & 255) * (1 - u) + ((c1 >> shift) & 255) * u);
    return (mix(16) << 16) | (mix(8) << 8) | mix(0);
  }
  return POCKET_STOPS[POCKET_STOPS.length - 1]![1];
}
const INITIAL_SOURCE = "3J2T";

// Leva drawn flat and see-through, so the window's frosting shows; text and inputs follow the UI theme
const LEVA_THEME = {
  dark: {
    colors: { elevation1: "transparent", elevation2: "transparent", elevation3: "rgba(255,255,255,0.08)" },
    sizes: { rootWidth: "100%" },
  },
  light: {
    colors: {
      elevation1: "transparent", elevation2: "transparent", elevation3: "rgba(0,0,0,0.06)",
      highlight1: "#71717a", highlight2: "#3f3f46", highlight3: "#09090b",
    },
    sizes: { rootWidth: "100%" },
  },
};

type WindowId = "parsing" | "surface" | "styling" | "render" | "debug";
const WINDOWS: { id: WindowId; label: string }[] = [
  { id: "parsing", label: "Parsing" },
  { id: "surface", label: "Surface" },
  { id: "styling", label: "Styling" },
  { id: "render", label: "Render" },
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

  const { theme, toggle: toggleThemeOnly } = useTheme();
  const { stores, reset, setBackground, parseOpts, style, spheres, selection, surface, labels, render } = useRendererControls(theme);
  // A background still at the other theme's default follows the theme; a custom one stays. On a toggle
  // this happens in the same update as the theme; the effect covers OS theme changes.
  const toggleTheme = () => toggleThemeOnly((next) => {
    if (style.background === DEFAULT_BACKGROUND[next === "dark" ? "light" : "dark"]) setBackground(DEFAULT_BACKGROUND[next]);
  });
  useEffect(() => {
    const other = theme === "dark" ? "light" : "dark";
    if (style.background === DEFAULT_BACKGROUND[other]) setBackground(DEFAULT_BACKGROUND[theme]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);
  const [representation, setRepresentation] = useState<Representation>("spheres");
  const [show, setShow] = useState({ atoms: true, bonds: true, backbone: true, ligands: true });
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("residue");
  const [surfaceOn, setSurfaceOn] = useState(false);
  const [pocketsOn, setPocketsOn] = useState(false);
  const [continuousRender, setContinuousRender] = useState(false);
  const [ligand, setLigand] = useState<LigandRef | null>(null);
  // A click on the open ligand closes its card; a new structure closes it too
  const toggleLigand = useCallback((l: LigandRef) => setLigand((cur) => (cur?.label === l.label ? null : l)), []);
  useEffect(() => { setLigand(null); }, [source.url]);
  const [open, setOpen] = usePersistentState<Record<WindowId, boolean>>("mol-viewer:windows", {
    parsing: false, surface: false, styling: false, render: false, debug: true,
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
  // Contacts of the ligand whose card is open
  const interactions = useMemo(() => (ligand && filteredScene ? findInteractions(filteredScene, ligand) : null), [ligand, filteredScene]);

  // A ligand swapped into the open ligand's pocket, aligned onto the original's pose
  const [swap, setSwap] = useState<(SwapState & { molecule?: SwapMolecule }) | null>(null);
  useEffect(() => { setSwap(null); }, [ligand?.label, source.url]);
  const swapIn = useCallback((candidate: Candidate) => {
    if (!ligand || !filteredScene) return;
    setSwap({ candidate, status: "loading" });
    const sameRequest = (cur: typeof swap) => cur?.candidate.id === candidate.id;
    conformer3D(candidate.smiles).then((mol) => {
      const { positions, shape, clashes } = alignOntoLigand(filteredScene, ligand, mol);
      setSwap((cur) => (sameRequest(cur) ? { candidate, status: "ready", fit: { shape, clashes }, molecule: { elements: mol.elements, positions, bonds: mol.bonds, bondOrders: mol.bondOrders } } : cur));
    }).catch((e) => {
      setSwap((cur) => (sameRequest(cur) ? { candidate, status: "error", error: e instanceof Error ? e.message : String(e) } : cur));
    });
  }, [ligand, filteredScene]);

  const [surfaceData, setSurfaceData] = useState<SurfaceData[] | null>(null);
  const [renderStats, setRenderStats] = useState<RenderStatsInfo | null>(null);
  const cameraRef = useRef<Camera | null>(null);

  // Path-traced render: progress goes straight to the preview (not through this component, at every sample)
  const pathTraceRef = useRef<PathTraceApi | null>(null);
  const [renderJob, setRenderJob] = useState<{ cancel: () => void; listeners: Set<(p: PathTraceProgress) => void>; last: PathTraceProgress | null; fileName: string } | null>(null);
  const [rendering, setRendering] = useState(false);
  const startRender = () => {
    const api = pathTraceRef.current;
    if (!api || rendering) return;
    renderJob?.cancel();
    const job = { cancel: () => {}, listeners: new Set<(p: PathTraceProgress) => void>(), last: null as PathTraceProgress | null, fileName: `${scene?.metadata?.pdbId ?? "render"}-${render.resolution}.png` };
    setRendering(true);
    job.cancel = api.start(
      { width: RENDER_RESOLUTIONS[render.resolution], samples: render.samples, emphasis: render.ligandFocus, depthOfField: render.depthOfField, fog: render.fog, background: style.background },
      (p) => {
        job.last = p;
        job.listeners.forEach((l) => l(p));
        if (p.stage === "done") setRendering(false);
      },
    );
    setRenderJob(job);
  };
  const closeRender = () => { renderJob?.cancel(); setRenderJob(null); setRendering(false); };
  // Surfaces stream in from a pool of workers; a new request supersedes (terminates) the one in flight
  const surfaceClient = useRef<SurfaceStreamClient | null>(null);
  useEffect(() => {
    const client = new SurfaceStreamClient(() => new SurfaceWorker());
    surfaceClient.current = client;
    return () => { client.dispose(); surfaceClient.current = null; };
  }, []);

  // Only while surfaces are on: one object per atom is too much heap for millions of atoms
  const { atomsInput, surfaceAtomScene } = useMemo(() => {
    const s = filteredScene;
    const n = s?.atoms?.count ?? 0;
    if (!surfaceOn || !s || n === 0) return { atomsInput: [] as Atom[], surfaceAtomScene: new Int32Array(0) };
    const out: Atom[] = [], sceneIndex: number[] = [];
    const pos = s.atoms.positions as Float32Array;
    const rad = s.atoms.radii as Float32Array;
    const residues = s.tables?.residues;
    const residueIndex = s.atoms.residueIndex;
    const charges = atomCharges(s);
    for (let i = 0; i < n; i++) {
      // Solvent is left out of surfaces, as in PyMOL
      if (residues && residueIndex && SOLVENT.has(residues[residueIndex[i]!]?.name ?? "")) continue;
      const j = i * 3;
      out.push(charges[i] ? { x: pos[j], y: pos[j + 1], z: pos[j + 2], radius: rad[i], charge: charges[i] } : { x: pos[j], y: pos[j + 1], z: pos[j + 2], radius: rad[i] });
      sceneIndex.push(i);
    }
    return { atomsInput: out, surfaceAtomScene: Int32Array.from(sceneIndex) };
  }, [filteredScene, surfaceOn]);

  // Pockets: polymer atoms only, so ligand, water and ion sites show as pockets; own worker, so the
  // surface and pockets don't cancel each other
  const pocketClient = useRef<SurfaceStreamClient | null>(null);
  useEffect(() => {
    const client = new SurfaceStreamClient(() => new SurfaceWorker());
    pocketClient.current = client;
    return () => { client.dispose(); pocketClient.current = null; };
  }, []);
  // index: best-first rank; lining: scene atom indices
  const [pockets, setPockets] = useState<(PocketMesh & { index: number; lining: Int32Array })[] | null>(null);
  useEffect(() => {
    const client = pocketClient.current, s = filteredScene;
    if (!pocketsOn || !s || !client) { client?.cancel(); setPockets(null); return; }
    const residueIndex = s.atoms.residueIndex, segments = s.tables?.chainSegments;
    const polymer = new Uint8Array(s.tables?.residues?.length ?? 0);
    for (const seg of segments ?? []) for (let r = seg.startResidue; r <= seg.endResidue; r++) polymer[r] = 1;
    const pos = s.atoms.positions as Float32Array, rad = s.atoms.radii as Float32Array;
    const atoms: Atom[] = [], groups: number[] = [], sceneIndex: number[] = [];
    for (let i = 0; i < s.atoms.count; i++) {
      if (segments && residueIndex && !polymer[residueIndex[i]!]) continue;
      atoms.push({ x: pos[i * 3]!, y: pos[i * 3 + 1]!, z: pos[i * 3 + 2]!, radius: rad[i]! });
      groups.push(residueIndex ? residueIndex[i]! : i);
      sceneIndex.push(i);
    }
    let cancelled = false, first = true;
    const p = cameraRef.current?.position;
    // Each pocket is drawn as the surface of the residues lining it; they stream in nearest first, and the
    // previous pockets stay until the first new one arrives
    client.findPockets(atoms, { atomGroups: Int32Array.from(groups), viewPoint: p && { x: p.x, y: p.y, z: p.z } }, (index, pocket) => {
      if (cancelled) return;
      const mesh = {
        positions: pocket.positions, normals: pocket.normals, indices: pocket.indices, color: pocketColor(pocket.score),
        index, lining: Int32Array.from(pocket.lining, (k) => sceneIndex[k]!),
      };
      if (first) { first = false; setPockets([mesh]); } else setPockets((prev) => [...(prev ?? []), mesh]);
    })
      .then(() => { if (!cancelled && first) setPockets([]); })
      .catch((e) => { if (!(e instanceof DOMException && e.name === "AbortError")) console.error("Pocket detection failed", e); });
    return () => { cancelled = true; };
  }, [filteredScene, pocketsOn]);

  // The previous surface stays on screen until the new one's first chunk arrives; only disabling clears it
  useEffect(() => {
    const client = surfaceClient.current;
    if (!surfaceOn || atomsInput.length === 0 || !client) { client?.cancel(); setSurfaceData(null); return; }
    let cancelled = false, first = true;
    const p = cameraRef.current?.position;
    client.generate(surface.kind, atomsInput, { probeRadius: surface.probeRadius, voxelSize: surface.voxelSize, viewPoint: p && { x: p.x, y: p.y, z: p.z } }, (chunk) => {
      if (cancelled) return;
      if (first) { first = false; setSurfaceData([chunk]); } else setSurfaceData((prev) => [...(prev ?? []), chunk]);
    })
      .catch((e) => { if (!(e instanceof DOMException && e.name === "AbortError")) console.error("Surface generation failed", e); });
    return () => { cancelled = true; };
  }, [atomsInput, surfaceOn, surface.kind, surface.probeRadius, surface.voxelSize]);

  // With the surface on, pockets are painted on it (their lining atoms' patches) rather than drawn over it
  const surfaceShowsPockets = surfaceOn && !!surfaceData?.length && !!pockets?.length;
  // Per surface atom: hydrophobicity when chosen, with pocket patches over it
  const hydrophobic = surfaceOn && surface.color === "hydrophobicity";
  const surfaceAtomColors = useMemo(() => {
    if ((!surfaceShowsPockets || !pockets) && !hydrophobic) return null;
    const out = new Float32Array(surfaceAtomScene.length * 3).fill(-1);
    if (hydrophobic && filteredScene) {
      const h = hydrophobicityColors(filteredScene);
      surfaceAtomScene.forEach((a, k) => out.set(h.subarray(a * 3, a * 3 + 3), k * 3));
    }
    if (surfaceShowsPockets && pockets) {
      const byScene = new Map<number, (typeof pockets)[number]>();
      // An atom lining several pockets takes the best one's colour
      for (const pk of pockets) for (const a of pk.lining) { const o = byScene.get(a); if (!o || pk.index < o.index) byScene.set(a, pk); }
      const c = new Color();
      surfaceAtomScene.forEach((a, k) => {
        const pk = byScene.get(a);
        if (pk) { c.set(pk.color); out[k * 3] = c.r; out[k * 3 + 1] = c.g; out[k * 3 + 2] = c.b; }
      });
    }
    return out;
  }, [surfaceShowsPockets, pockets, hydrophobic, filteredScene, surfaceAtomScene]);

  const renderControls = useMemo<RenderControls>(() => ({
    renderMode: representation,
    showAtoms: show.atoms,
    showBonds: show.bonds,
    showBackbone: show.backbone,
    showLigands: show.ligands,
    radiusScale: spheres.radiusScale,
  }), [representation, show.atoms, show.bonds, show.backbone, show.ligands, spheres.radiusScale]);

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
    <FloatingWindow key={id} id={id} title={title} width={300} resizable defaultPosition={{ x: 12 + index * 24, y: 68 + index * 24 }} onClose={() => toggleWindow(id)} onReset={reset[id]}>
      <LevaPanel store={stores[id]} fill flat titleBar={false} hideCopyButton oneLineLabels theme={LEVA_THEME[theme]} />
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
            cameraRef={cameraRef}
            pathTraceRef={pathTraceRef}
            surfaceWireframe={surface.wireframe}
            surfaceOpacity={surface.opacity}
            pockets={surfaceShowsPockets ? null : pockets}
            surfaceAtomColors={surfaceAtomColors}
            surfacePotentialRange={surface.color === "electrostatics" ? POTENTIAL_RANGE : null}
            onLigandClick={toggleLigand}
            interactions={interactions}
            siteLigand={ligand}
            siteLabels={labels}
            swapMolecule={swap?.molecule ?? null}
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
        theme={theme}
        onToggleTheme={toggleTheme}
        onRender={startRender}
        rendering={rendering}
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
        onSurface={(on) => { setSurfaceOn(on); setOpen((o) => ({ ...o, surface: on })); }}
        pockets={pocketsOn}
        onPockets={setPocketsOn}
        pocketCount={pockets?.length}
      />

      {levaWindow("parsing", "Parsing", 0)}
      {levaWindow("surface", "Surface", 1)}
      {levaWindow("styling", "Styling", 2)}
      {levaWindow("render", "Render", 3)}
      {renderJob && (
        <FloatingWindow id="render-preview" title="Render" width={420} resizable defaultPosition={{ x: window.innerWidth - 440, y: window.innerHeight - 380 }} onClose={closeRender}>
          <RenderJobPreview job={renderJob} onCancel={closeRender} />
        </FloatingWindow>
      )}
      {ligand && (
        <FloatingWindow id="ligand" title={`Ligand · ${ligand.label}`} width={440} resizable defaultPosition={{ x: window.innerWidth - 660, y: 68 }} onClose={() => setLigand(null)}>
          <LigandCard
            pdbId={scene?.metadata?.pdbId ?? source.pdbId}
            compId={ligand.compId}
            scene={filteredScene}
            ligand={ligand}
            interactions={interactions ?? []}
            swap={swap}
            onSwap={swapIn}
            onClearSwap={() => setSwap(null)}
          />
        </FloatingWindow>
      )}
      {open.debug && (
        <FloatingWindow id="debug" title="Debug" width={240} defaultPosition={{ x: 12, y: window.innerHeight - 260 }} onClose={() => toggleWindow("debug")}>
          <div ref={setStatsEl} className="mb-2 [&>div]:!relative" />
          <div className="space-y-0.5 font-mono text-xs text-(--ui-fg)">
            <div>Atoms: {atomCount.toLocaleString()}</div>
            <div>Bonds: {bondCount.toLocaleString()}</div>
            {renderStats && <div>Triangles: {renderStats.triangles.toLocaleString()}</div>}
            {renderStats && <div>Draw calls: {renderStats.drawCalls.toLocaleString()}</div>}
            <div className="pt-1 text-(--ui-muted)">{status ?? "Ready"}</div>
          </div>
          <label className="mt-2 flex items-center justify-between text-xs text-(--ui-fg)">
            <span>Render continuously</span>
            <input type="checkbox" className="h-3.5 w-3.5 accent-(--ui-fg)" checked={continuousRender} onChange={(e) => setContinuousRender(e.target.checked)} />
          </label>
        </FloatingWindow>
      )}
    </div>
  );
}

/** Subscribes to a render job's progress, so only the preview re-renders at every sample. */
function RenderJobPreview({ job, onCancel }: { job: { listeners: Set<(p: PathTraceProgress) => void>; last: PathTraceProgress | null; fileName: string }; onCancel: () => void }) {
  const [progress, setProgress] = useState(job.last);
  useEffect(() => {
    job.listeners.add(setProgress);
    return () => { job.listeners.delete(setProgress); };
  }, [job]);
  return progress ? <RenderPreview progress={progress} onCancel={onCancel} fileName={job.fileName} /> : null;
}
