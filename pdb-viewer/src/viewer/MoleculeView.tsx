import { Suspense, useEffect, useState, useRef, useCallback } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, AdaptiveDpr, Preload } from "@react-three/drei";
import { Leva, useControls } from "leva";
import { useMolScene } from "../lib/hooks/useMolScene";
import type { ParseOptions, MolScene, AtomMeshOptions } from "pdb-parser";
import { useChainSelection } from "../lib/hooks/useChainSelection";
import { useFilteredScene } from "../lib/hooks/useFilteredScene";
import { useSceneObjects } from "../lib/hooks/useSceneObjects";
import { useCameraFrameOnScene, type ControlsRef } from "../lib/hooks/useCameraFrameOnScene";
import { useRibbonGroup } from "../lib/hooks/useRibbonGroup";
import { useRenderKeys, type Representation } from "../lib/hooks/useRenderKeys";

// Scene objects hook imported from ../lib/hooks/useSceneObjects

export function MoleculeView() {
  // Controls: parsing + rendering
  const [sourceUrl, setSourceUrl] = useState<string>("/models/1IGY.pdb");

  const parseOpts = useControls("Parse", {
    altLocPolicy: { value: "occupancy", options: ["occupancy", "all"] as ParseOptions["altLocPolicy"][] },
    modelSelection: { value: 1, min: 1, step: 1 },
    bondPolicy: { value: "conect+heuristic", options: ["conect-only", "heuristic-if-missing", "conect+heuristic"] as ParseOptions["bondPolicy"][] },
  });

  // Common controls
  const common = useControls("Common", {
    representation: { value: "spheres", options: ["spheres", "ribbon-tube", "ribbon-flat"] as const },
    materialKind: { value: "standard", options: ["basic", "lambert", "standard"] as const },
    background: { value: "#111111" },
  });

  // Overlays (apply across modes)
  const overlays = useControls("Overlays", {
    atoms: {
      value: true,
      render: (get) => get("Common.representation") === "spheres",
    },
    bonds: true,
    backbone: {
      value: true,
      render: (get) => get("Common.representation") === "spheres",
    },
  });

  // Spheres-only controls
  const spheres = useControls("Spheres", {
    sphereDetail: {
      value: 16, min: 4, max: 32, step: 2,
      render: (get) => get("Common.representation") === "spheres",
    },
    radiusScale: {
      value: 0.3, min: 0.05, max: 2.0, step: 0.05,
      render: (get) => get("Common.representation") === "spheres",
    },
  });

  // Ribbon-only controls
  const ribbon = useControls("Ribbon", {
    thickness: {
      value: 0.18, min: 0.02, max: 0.6, step: 0.01,
      render: (get) => get("Common.representation") === "ribbon-flat",
    },
  });

  const { scene, error, loading } = useMolScene(sourceUrl, parseOpts as ParseOptions);

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
    atoms: overlays.atoms && common.representation === "spheres"
      ? { sphereDetail: spheres.sphereDetail, materialKind: common.materialKind as AtomMeshOptions["materialKind"], radiusScale: spheres.radiusScale }
      : false,
    bonds: overlays.bonds,
    backbone: overlays.backbone && common.representation === "spheres" ? {} : false,
  });

  // Ribbon group via hook (handles build + disposal)
  const ribbonGroup = useRibbonGroup(
    filteredScene,
    common.representation as "spheres" | "ribbon-tube" | "ribbon-flat",
    common.materialKind as AtomMeshOptions["materialKind"],
    { thickness: ribbon.thickness }
  );

  // Render keys (derived from selection + overlays + representation)
  const keys = useRenderKeys(selectionKey, common.representation as Representation, {
    atoms: overlays.atoms,
    bonds: overlays.bonds,
    backbone: overlays.backbone,
  });

  useEffect(() => {
    document.body.style.background = common.background;
  }, [common.background]);

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
      {/* Chain selector panel */}
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
      >
        <color attach="background" args={[common.background]} />
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
          {common.representation !== "spheres" && ribbonGroup && (
            <>
              <primitive key={keys.ribbon} object={ribbonGroup} />
              {overlays.bonds && objects.bonds && <primitive key={keys.bonds} object={objects.bonds} />}
              {overlays.backbone && objects.backbone && <primitive key={keys.backbone} object={objects.backbone} />}
            </>
          )}
          {common.representation === "spheres" && (
            <>
              {objects.atoms && <primitive key={keys.atoms} object={objects.atoms} />}
              {objects.bonds && <primitive key={keys.bonds} object={objects.bonds} />}
              {objects.backbone && <primitive key={keys.backbone} object={objects.backbone} />}
            </>
          )}
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
