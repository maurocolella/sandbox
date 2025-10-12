import { Suspense, useEffect, useState, useRef, useCallback } from "react";
import { Canvas, type ThreeEvent, useThree, invalidate } from "@react-three/fiber";
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
import { useSelectionLookups } from "../lib/hooks/useSelectionLookups";
import { useRenderKeys, type Representation } from "../lib/hooks/useRenderKeys";
import { useHoverHighlight } from "../lib/hooks/useHoverHighlight";
import { useBondLinkedHoverHighlight } from "../lib/hooks/useBondLinkedHoverHighlight";
import { useHoverOverlays } from "../lib/hooks/useHoverOverlays";
// Scene objects hook imported from ../lib/hooks/useSceneObjects
import { StructureControls } from "./StructureControls";

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
    materialKind: { value: "lambert", options: ["basic", "lambert", "standard"] as const },
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
    mode: { value: "residue", options: ["none", "atom", "residue", "chain"] as const },
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
  const effectiveMode = (selection.mode === "none" ? "atom" : selection.mode) as "atom" | "residue" | "chain";
  const hover = useHoverHighlight(
    filteredScene,
    objects.atoms,
    effectiveMode,
    selection.hoverTint as string,
    isSpheres && selection.mode !== "none",
    true,
    false
  );

  // Track camera motion to suspend expensive hover raycasts while orbiting/damping
  const isCameraMoving = useRef<boolean>(false);
  const cameraIdleTimer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (cameraIdleTimer.current !== null) {
        clearTimeout(cameraIdleTimer.current);
        cameraIdleTimer.current = null;
      }
    };
  }, []);

  const lookups = useSelectionLookups(filteredScene as MolScene | null);

  // Bond tubes linked hover highlight: respond to hovered chain/residue from atom mesh
  useBondLinkedHoverHighlight(
    filteredScene,
    objects.bonds as unknown as THREE.InstancedMesh | undefined,
    effectiveMode,
    selection.mode === "chain" ? hover.hovered : -1,
    selection.mode === "residue" ? hover.hovered : -1,
    selection.hoverTint as string,
    Boolean(objects.bonds) && selection.mode !== "none"
  );

  // Always-on-top hover overlays (depthTest=false) drawn last
  const { atomOverlay: hoverAtomOverlay, bondOverlay: hoverBondOverlay } = useHoverOverlays(filteredScene, {
    mode: effectiveMode,
    hoveredAtom: selection.mode === "atom" ? (hover.hovered ?? -1) : -1,
    hoveredResidue: selection.mode === "residue" ? hover.hovered : -1,
    hoveredChain: selection.mode === "chain" ? hover.hovered : -1,
    color: selection.hoverTint as string,
    radiusScale: spheres.radiusScale,
    sphereDetail: spheres.sphereDetail,
    onTop: selection.onTopHighlight,
  }, lookups);

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
    hover.onPointerOut();
  }, [hover]);



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

  const atomCount = filteredScene?.atoms?.count ?? 0;
  const bondCount = filteredScene?.bonds?.count ?? 0;

  function ManualRaycast({ atoms, onHover, onOut }: {
    atoms: THREE.InstancedMesh | undefined;
    onHover: (e: ThreeEvent<PointerEvent>) => void;
    onOut: () => void;
  }) {
    const { camera, gl } = useThree();
    const rayRef = useRef(new THREE.Raycaster());
    const lastPos = useRef(new THREE.Vector2(9999, 9999));
    const leftDown = useRef(false);
    const eps = 0.001;
    const lastInstanceId = useRef<number | null>(null);
    const lastRaycastAt = useRef<number>(0);

    useEffect(() => {
      const el = gl.domElement;
      const handleMove = (event: MouseEvent) => {
        const rect = el.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        const pos = new THREE.Vector2(x, y);
        if (leftDown.current) return;
        if (event.buttons !== 0) return; // skip raycasts during any mouse button drag
        // While the camera is moving (orbit/damping), reduce raycast frequency instead of skipping entirely
        if (isCameraMoving.current) {
          const now = performance.now();
          const minIntervalMs = 1000;
          if (now - lastRaycastAt.current < minIntervalMs) return;
          lastRaycastAt.current = now;
        }
        if (pos.distanceTo(lastPos.current) < eps) return;
        lastPos.current.copy(pos);
        if (!atoms) {
          if (lastInstanceId.current !== null) {
            onOut();
            lastInstanceId.current = null;
            invalidate();
          }
          return;
        }
        rayRef.current.setFromCamera(pos, camera);
        const hit = rayRef.current.intersectObject(atoms, false)[0];
        const instanceId = hit?.instanceId;
        if (instanceId == null) {
          if (lastInstanceId.current !== null) {
            onOut();
            lastInstanceId.current = null;
            invalidate();
          }
        } else if (lastInstanceId.current !== instanceId) {
          lastInstanceId.current = instanceId;
          const fakeEvt = {
            stopPropagation: () => {},
            instanceId,
          } as unknown as ThreeEvent<PointerEvent>;
          onHover(fakeEvt);
          invalidate();
        }
      };
      const handleDown = () => { leftDown.current = true; };
      const handleUp = () => { leftDown.current = false; };
      const handleLeave = () => { onOut(); };
      el.addEventListener("mousemove", handleMove);
      el.addEventListener("mousedown", handleDown);
      el.addEventListener("mouseup", handleUp);
      el.addEventListener("mouseleave", handleLeave);
      return () => {
        el.removeEventListener("mousemove", handleMove);
        el.removeEventListener("mousedown", handleDown);
        el.removeEventListener("mouseup", handleUp);
        el.removeEventListener("mouseleave", handleLeave);
      };
    }, [gl, camera, atoms, onHover, onOut]);

    return null;
  }

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
      <Canvas
        frameloop="demand"
        gl={{ antialias: true, powerPreference: 'high-performance' }}
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
          onStart={() => {
            isCameraMoving.current = true;
            if (cameraIdleTimer.current !== null) {
              clearTimeout(cameraIdleTimer.current);
              cameraIdleTimer.current = null;
            }
            // Clear hover immediately when orbit starts
            hover.onPointerOut();
            invalidate();
          }}
          onChange={() => {
            // Any camera change marks movement; release after short idle
            isCameraMoving.current = true;
            if (cameraIdleTimer.current !== null) clearTimeout(cameraIdleTimer.current);
            cameraIdleTimer.current = window.setTimeout(() => {
              isCameraMoving.current = false;
            }, 120);
          }}
          onEnd={() => {
            // End fires before damping fully settles; wait briefly
            if (cameraIdleTimer.current !== null) clearTimeout(cameraIdleTimer.current);
            cameraIdleTimer.current = window.setTimeout(() => {
              isCameraMoving.current = false;
            }, 120);
          }}
          dampingFactor={0.1}
          makeDefault
        />
        <AdaptiveDpr pixelated />
        <Preload all />
        <Suspense fallback={null}>
          <group>
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
                  />
                )}
                {objects.bonds && <primitive key={keys.bonds} object={objects.bonds} />}
                {objects.backbone && <primitive key={keys.backbone} object={objects.backbone} />}
                {isSpheres && hoverAtomOverlay && (
                  <primitive key="hover-atom-overlay" object={hoverAtomOverlay} />
                )}
                {isSpheres && hoverBondOverlay && (
                  <primitive key="hover-bond-overlay" object={hoverBondOverlay} />
                )}
              </>
            )}
          </group>
          {display.representation === "spheres" && (
            <ManualRaycast atoms={objects.atoms as THREE.InstancedMesh | undefined} onHover={hover.onPointerMove} onOut={hover.onPointerOut} />
          )}
        </Suspense>
      </Canvas>
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
