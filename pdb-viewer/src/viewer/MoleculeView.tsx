import { Suspense, useEffect, useState, useRef, useCallback } from "react";
import { Canvas, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls, AdaptiveDpr, Preload } from "@react-three/drei";
import { Leva, useControls } from "leva";
import * as THREE from "three";
import { useMolScene } from "../lib/hooks/useMolScene";
import type { ParseOptions, MolScene, AtomMeshOptions } from "pdb-parser";
import { useChainSelection } from "../lib/hooks/useChainSelection";
import { useFilteredScene } from "../lib/hooks/useFilteredScene";
import { useSceneObjects } from "../lib/hooks/useSceneObjects";
import { useCameraFrameOnScene, type ControlsRef } from "../lib/hooks/useCameraFrameOnScene";
import { useRibbonGroup } from "../lib/hooks/useRibbonGroup";
import { useRenderKeys, type Representation } from "../lib/hooks/useRenderKeys";
import { useChainHoverHighlight } from "../lib/hooks/useChainHoverHighlight";
import { useAtomHoverHighlight } from "../lib/hooks/useAtomHoverHighlight";
import { useResidueHoverHighlight } from "../lib/hooks/useResidueHoverHighlight";
import { useBondLinkedHoverHighlight } from "../lib/hooks/useBondLinkedHoverHighlight";
import { useHoverOverlays } from "../lib/hooks/useHoverOverlays";
// Scene objects hook imported from ../lib/hooks/useSceneObjects

export function MoleculeView() {
  // Controls: parsing + rendering
  const [sourceUrl, setSourceUrl] = useState<string>("/models/1IGY.pdb");

  const parseOpts = useControls("Parsing", {
    altLocPolicy: { value: "occupancy", options: ["occupancy", "all"] as ParseOptions["altLocPolicy"][] },
    bondPolicy: { value: "conect+heuristic", options: ["conect-only", "heuristic-if-missing", "conect+heuristic"] as ParseOptions["bondPolicy"][] },
    useModelSelection: { value: false },
    modelSelection: {
      value: 1,
      min: 1,
      step: 1,
      render: (get) => Boolean(get("Parsing.useModelSelection")),
    },
  }, { collapsed: true });

  // Display: representation + overlay toggles
  const display = useControls("Display", {
    representation: { value: "spheres", options: ["spheres", "ribbon-tube", "ribbon-flat"] as const },
    atoms: {
      value: true,
      render: (get) => get("Display.representation") === "spheres",
    },
    bonds: true,
    backbone: {
      value: true,
      render: (get) => get("Display.representation") === "spheres",
    },
  });

  // Styling: material + background
  const style = useControls("Styling", {
    materialKind: { value: "standard", options: ["basic", "lambert", "standard"] as const },
    background: { value: "#111111" },
  }, { collapsed: true });

  // Spheres-only controls
  const spheres = useControls("Spheres", {
    sphereDetail: {
      value: 16, min: 4, max: 32, step: 2,
      render: (get) => get("Display.representation") === "spheres",
    },
    radiusScale: {
      value: 0.3, min: 0.05, max: 2.0, step: 0.05,
      render: (get) => get("Display.representation") === "spheres",
    },
  });

  // Ribbon-only controls
  const ribbon = useControls("Ribbon", {
    thickness: {
      value: 0.18, min: 0.02, max: 0.6, step: 0.01,
      render: (get) => get("Display.representation") === "ribbon-flat",
    },
  });

  // Selection toolbox: atom/residue/chain + hover tint
  const selection = useControls("Selection", {
    mode: { value: "chain", options: ["atom", "residue", "chain"] as const },
    hoverTint: { value: "#ff00ff" },
    // outlineWidth: { value: 2.5, min: 0.5, max: 6.0, step: 0.1 },
    onTopHighlight: { value: true },
  });

  // Only include modelSelection if user actually picked a number
  const parseOptions: ParseOptions = {
    altLocPolicy: parseOpts.altLocPolicy as ParseOptions["altLocPolicy"],
    bondPolicy: parseOpts.bondPolicy as ParseOptions["bondPolicy"],
    ...(parseOpts.useModelSelection ? { modelSelection: parseOpts.modelSelection as number } : {}),
  };
  const { scene, error, loading } = useMolScene(sourceUrl, parseOptions);

  // Chain selection domain hook
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

  // Filtered scene domain hook
  const { filtered: filteredScene, selectionKey } = useFilteredScene(scene as MolScene | null, selectedChainIndices);
  const objects = useSceneObjects(filteredScene, {
    atoms: display.atoms && display.representation === "spheres"
      ? { sphereDetail: spheres.sphereDetail, materialKind: style.materialKind as AtomMeshOptions["materialKind"], radiusScale: spheres.radiusScale }
      : false,
    bonds: display.bonds,
    backbone: display.backbone && display.representation === "spheres" ? {} : false,
  });

  // Hover highlight hooks for different selection granularity (only one enabled at a time)
  const isSpheres = display.representation === "spheres";
  const atomHover = useAtomHoverHighlight(
    filteredScene,
    objects.atoms,
    selection.hoverTint as string,
    isSpheres && selection.mode === "atom",
    true
  );
  const residueHover = useResidueHoverHighlight(
    filteredScene,
    objects.atoms,
    selection.hoverTint as string,
    isSpheres && selection.mode === "residue",
    true
  );
  const chainHover = useChainHoverHighlight(
    filteredScene,
    objects.atoms,
    selection.hoverTint as string,
    isSpheres && selection.mode === "chain",
    true
  );
  const hover = selection.mode === "atom" ? atomHover : selection.mode === "residue" ? residueHover : chainHover;

  // Bond tubes linked hover highlight: respond to hovered chain/residue from atom mesh
  useBondLinkedHoverHighlight(
    filteredScene,
    objects.bonds as unknown as THREE.InstancedMesh | undefined,
    selection.mode as "atom" | "residue" | "chain",
    chainHover.hovered,
    residueHover.hovered,
    selection.hoverTint as string,
    Boolean(objects.bonds)
  );

  // Always-on-top hover overlays (depthTest=false) drawn last
  const { atomOverlay: hoverAtomOverlay, bondOverlay: hoverBondOverlay } = useHoverOverlays(filteredScene, {
    mode: selection.mode as "atom" | "residue" | "chain",
    hoveredAtom: atomHover.hovered ?? -1,
    hoveredResidue: residueHover.hovered,
    hoveredChain: chainHover.hovered,
    color: selection.hoverTint as string,
    radiusScale: spheres.radiusScale,
    sphereDetail: spheres.sphereDetail,
  });

  // Ribbon group via hook (handles build + disposal)
  const ribbonGroup = useRibbonGroup(
    filteredScene,
    display.representation as "spheres" | "ribbon-tube" | "ribbon-flat",
    style.materialKind as AtomMeshOptions["materialKind"],
    { thickness: ribbon.thickness }
  );

  // Render keys (derived from selection + overlays + representation)
  const keys = useRenderKeys(selectionKey, display.representation as Representation, {
    atoms: display.atoms,
    bonds: display.bonds,
    backbone: display.backbone,
  });

  const handleCanvasPointerLeave = useCallback(() => {
    chainHover.onPointerOut();
    residueHover.onPointerOut();
  }, [chainHover, residueHover]);

  const handleScenePointerMove = useCallback((e: ThreeEvent<PointerEvent>) => {
    if (!objects.atoms) return;
    const hits = e.intersections || [];
    const hitAtoms = hits.some((i) => i.object === objects.atoms);
    if (!hitAtoms) {
      chainHover.onPointerOut();
      residueHover.onPointerOut();
    }
  }, [objects.atoms, chainHover, residueHover]);

  const handleScenePointerLeave = useCallback(() => {
    chainHover.onPointerOut();
    residueHover.onPointerOut();
  }, [chainHover, residueHover]);

  // Ensure bonds/backbone do not steal pointer events; atoms drive hover state
  useEffect(() => {
    if (objects.bonds) {
      (objects.bonds as unknown as { raycast?: (...args: unknown[]) => void }).raycast = () => { };
    }
    if (objects.backbone) {
      (objects.backbone as unknown as { raycast?: (...args: unknown[]) => void }).raycast = () => { };
    }
  }, [objects.bonds, objects.backbone]);

  useEffect(() => {
    document.body.style.background = style.background;
  }, [style.background]);

  const controlsRef = useRef<ControlsRef | null>(null);
  // Camera frame hook on ORIGINAL scene (decoupled from chain visibility)
  useCameraFrameOnScene(scene as MolScene | null, controlsRef.current, loading);

  return (
    <div style={{ display: 'flex', height: '100%', flex: 1 }}>
      <Leva collapsed={false} oneLineLabels hideCopyButton />
      <div style={{ position: "absolute", top: 10, left: 10, zIndex: 1 }}>
        <input
          type="text"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder="/models/1IGY.pdb or URL"
          style={{ width: 320, padding: 10, background: "#222", color: "#eee", border: "1px solid #444", borderRadius: 4 }}
        />
      </div>
      {/* Chain selector panel (always visible; chain visibility is orthogonal to selection mode) */}
      {scene?.tables?.chains && scene.tables.chains.length > 0 && (
        <div style={{ position: "absolute", top: 52, left: 10, zIndex: 1, background: "#1b1b1b", border: "1px solid #333", borderRadius: 6, padding: 10, color: "#ddd", fontFamily: "system-ui, sans-serif", fontSize: 12, maxHeight: 240, overflowY: "auto", minWidth: 160 }}>
          <div style={{ marginBottom: 6, fontWeight: 600 }}>Chains</div>
          {scene.tables.chains.map((c, idx) => (
            <label key={idx} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <input
                type="checkbox"
                checked={chainSelected[idx] !== false}
                onChange={(e) => handleChainCheckbox(idx, e.target.checked)}
              />
              <span>{c.id || "(blank)"}</span>
            </label>
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button
              onClick={handleAllChains}
              style={{ background: "#2a2a2a", color: "#eee", border: "1px solid #444", borderRadius: 4, padding: "4px 8px" }}
            >All</button>
            <button
              onClick={handleNoChains}
              style={{ background: "#2a2a2a", color: "#eee", border: "1px solid #444", borderRadius: 4, padding: "4px 8px" }}
            >None</button>
          </div>
        </div>
      )}
      <Canvas
        gl={{ antialias: true }}
        dpr={[1, Math.min(window.devicePixelRatio || 1, 2)]}
        camera={{ position: [0, 0, 100], near: 0.1, far: 5000 }}
        onPointerLeave={handleCanvasPointerLeave}
      >
        <color attach="background" args={[style.background]} />
        <ambientLight intensity={1.0} />
        <directionalLight position={[5, 10, 5]} intensity={1.0} />
        <OrbitControls
          ref={(ctrl) => {
            // ctrl is OrbitControls from drei; store minimal fields we use
            if (ctrl) controlsRef.current = ctrl as unknown as ControlsRef;
          }}
          enableDamping
          dampingFactor={0.1}
          makeDefault
        />
        <AdaptiveDpr pixelated />
        <Preload all />
        <Suspense fallback={null}>
          <group onPointerMove={handleScenePointerMove} onPointerLeave={handleScenePointerLeave}>
            {display.representation !== "spheres" && ribbonGroup && (
              <>
                <primitive key={keys.ribbon} object={ribbonGroup} />
                {display.bonds && objects.bonds && (
                  <primitive key={keys.bonds} object={objects.bonds} />
                )}
                {display.backbone && objects.backbone && <primitive key={keys.backbone} object={objects.backbone} />}
              </>
            )}
            {display.representation === "spheres" && (
              <>
                {objects.atoms && (
                  <primitive
                    key={keys.atoms}
                    object={objects.atoms}
                    onPointerMove={hover.onPointerMove}
                    onPointerOut={hover.onPointerOut}
                  />
                )}
                {objects.bonds && <primitive key={keys.bonds} object={objects.bonds} />}
                {objects.backbone && <primitive key={keys.backbone} object={objects.backbone} />}
                {isSpheres && selection.onTopHighlight && hoverAtomOverlay && (
                  <primitive key="hover-atom-overlay" object={hoverAtomOverlay} />
                )}
                {isSpheres && selection.onTopHighlight && hoverBondOverlay && (
                  <primitive key="hover-bond-overlay" object={hoverBondOverlay} />
                )}
              </>
            )}
          </group>
        </Suspense>
      </Canvas>
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
