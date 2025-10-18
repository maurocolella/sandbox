import { Suspense, useCallback, useMemo, useState, useEffect } from "react";
import type { MolScene } from "pdb-parser";
import { useMolScene } from "../lib/hooks/useMolScene";
import { useRendererControls } from "../lib/hooks/useRendererControls";
import { useChainSelection } from "../lib/hooks/useChainSelection";
import { useFilteredScene } from "mol-renderer";
import { MoleculeRender } from "mol-renderer";
import type { RenderControls, OverlayControls } from "mol-renderer";
import * as THREE from "three";
import { generateVDW, generateSAS, generateSES, type Atom } from "chem-surface";
import { Leva } from "leva";
import { StructureControls } from "./StructureControls";

export function MainView() {
  const [sourceUrl, setSourceUrl] = useState<string>("/models/1IGY.pdb");

  const { parseOpts, display, style, spheres, selection, surface } = useRendererControls();

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

  const [surfaceMesh, setSurfaceMesh] = useState<THREE.Object3D | null>(null);

  const atomsInput = useMemo<Atom[]>(() => {
    const s = filteredScene;
    const n = s?.atoms?.count ?? 0;
    if (!s || n === 0) return [];
    const out: Atom[] = new Array(n);
    const pos = s.atoms.positions as Float32Array;
    const rad = s.atoms.radii as Float32Array;
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      out[i] = { x: pos[j], y: pos[j + 1], z: pos[j + 2], radius: rad[i] };
    }
    return out;
  }, [filteredScene]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!surface.enabled || atomsInput.length === 0) { setSurfaceMesh(null); return; }
      const opts = { probeRadius: surface.probeRadius, voxelSize: surface.voxelSize };
      const geom = surface.kind === "vdw" ? await generateVDW(atomsInput, opts)
        : surface.kind === "sas" ? await generateSAS(atomsInput, opts)
        : await generateSES(atomsInput, opts);
      if (cancelled) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(geom.positions, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(geom.normals, 3));
      if (geom.indices) g.setIndex(new THREE.BufferAttribute(geom.indices, 1));
      const m = new THREE.MeshStandardMaterial({ color: 0x77aaff, metalness: 0.0, roughness: 1.0, transparent: false, opacity: 1.0, depthWrite: true, side: THREE.FrontSide, polygonOffset: surface.wireframe, polygonOffsetFactor: surface.wireframe ? 1 : 0, polygonOffsetUnits: surface.wireframe ? 1 : 0 });
      const mesh = new THREE.Mesh(g, m);
      mesh.renderOrder = 1;
      mesh.frustumCulled = false;

      if (surface.wireframe) {
        const wfGeo = new THREE.WireframeGeometry(g);
        const wfMat = new THREE.LineBasicMaterial({ color: 0x111111 });
        wfMat.depthTest = true;
        wfMat.depthWrite = false;
        wfMat.polygonOffset = true;
        wfMat.polygonOffsetFactor = -2;
        wfMat.polygonOffsetUnits = -1;
        const lines = new THREE.LineSegments(wfGeo, wfMat);
        lines.renderOrder = 2;
        const group = new THREE.Group();
        group.add(mesh);
        group.add(lines);
        setSurfaceMesh(group);
      } else {
        setSurfaceMesh(mesh);
      }
    }
    void run();
    return () => {
      cancelled = true;
      setSurfaceMesh(prev => {
        if (prev) {
          prev.traverse(obj => {
            const anyObj = obj as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
            if (anyObj.geometry) anyObj.geometry.dispose();
            if (anyObj.material) {
              if (Array.isArray(anyObj.material)) anyObj.material.forEach(mat => (mat as THREE.Material).dispose?.());
              else (anyObj.material as THREE.Material).dispose?.();
            }
          });
        }
        return null;
      });
    };
  }, [atomsInput, surface.enabled, surface.kind, surface.probeRadius, surface.voxelSize, surface.wireframe]);

  const renderControls = useMemo<RenderControls>(() => ({
    renderMode: display.representation as "spheres" | "ribbon-tube" | "ribbon-flat",
    showAtoms: display.atoms,
    showBonds: display.bonds,
    showBackbone: display.backbone,
    radiusScale: spheres.radiusScale,
    sphereDetail: spheres.sphereDetail,
  }), [display.representation, display.atoms, display.bonds, display.backbone, spheres.radiusScale, spheres.sphereDetail]);

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
            scene={scene}
            background={style.background}
            renderControls={renderControls}
            overlayControls={overlayControls}
            visibleChains={selectedChainIndices}
            surface={surfaceMesh}
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
