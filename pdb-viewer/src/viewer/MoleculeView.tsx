/*
 Title: MoleculeView
 Description: Top-level viewer component. Loads/parses a MolScene, manages chain filtering and UI controls,
 builds scene objects (atoms/bonds/backbone or ribbons), configures adaptive rendering, and wires a grid-
 accelerated raycaster to drive hover overlays without shader patching.
*/
import { Suspense, useEffect, useState, useRef, useCallback } from "react";
import { Canvas, invalidate } from "@react-three/fiber";
import { OrbitControls, AdaptiveDpr, Preload } from "@react-three/drei";
import { Leva } from "leva";
import { useMolScene } from "../lib/hooks/useMolScene";
import type { ParseOptions, MolScene, AtomMeshOptions } from "pdb-parser";
import { useChainSelection } from "../lib/hooks/useChainSelection";
import { useFilteredScene } from "../lib/hooks/useFilteredScene";
import { useSceneObjects } from "../lib/hooks/useSceneObjects";
import { useCameraFrameOnScene, type ControlsRef } from "../lib/hooks/useCameraFrameOnScene";
import { useRibbonGroup } from "../lib/hooks/useRibbonGroup";
import { useSelectionLookups } from "../lib/hooks/useSelectionLookups";
import { useRenderKeys, type Representation } from "../lib/hooks/useRenderKeys";
import { useHoverOverlays } from "../lib/hooks/useHoverOverlays";
import { useHoverState } from "../lib/hooks/useHoverState";
import { useCameraMotion } from "../lib/hooks/useCameraMotion";
import { useRendererControls } from "../lib/hooks/useRendererControls";
// Scene objects hook imported from ../lib/hooks/useSceneObjects
import { StructureControls } from "./StructureControls";
import { GridRaycast, type BBox } from "./GridRaycast";


export function MoleculeView() {
  // Controls: parsing + rendering
  const [sourceUrl, setSourceUrl] = useState<string>("/models/1HTQ.pdb");

  const { parseOpts, display, style, spheres, ribbon, selection } = useRendererControls();

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

  // Hover state via hook (no shader patching)
  const isSpheres = display.representation === "spheres";
  const effectiveMode = (selection.mode === "none" ? "atom" : selection.mode) as "atom" | "residue" | "chain";
  const { hoveredAtom, hoveredResidue, hoveredChain, onHover, onOut } = useHoverState(
    filteredScene as MolScene | null,
    effectiveMode
  );

  // Camera motion tracking via hook
  const { isCameraMoving, onControlsStart, onControlsChange, onControlsEnd } = useCameraMotion(120);

  const lookups = useSelectionLookups(filteredScene as MolScene | null);

  // Always-on-top hover overlays (depthTest=false) drawn last
  const { atomOverlay: hoverAtomOverlay, bondOverlay: hoverBondOverlay } = useHoverOverlays(filteredScene, {
    mode: effectiveMode,
    hoveredAtom: selection.mode === "atom" ? hoveredAtom : -1,
    hoveredResidue: selection.mode === "residue" ? hoveredResidue : -1,
    hoveredChain: selection.mode === "chain" ? hoveredChain : -1,
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
    onOut();
  }, [onOut]);

  // Ensure bonds/backbone do not steal pointer events; atoms drive hover state
  useEffect(() => {
    if (objects.bonds) {
      (objects.bonds as unknown as { raycast?: (...args: unknown[]) => void }).raycast = () => { };
    }
    if (objects.backbone) {
      (objects.backbone as unknown as { raycast?: (...args: unknown[]) => void }).raycast = () => { };
    }
  }, [objects.bonds, objects.backbone]);

  const controlsRef = useRef<ControlsRef | null>(null);
  // Camera frame hook on ORIGINAL scene (decoupled from chain visibility)
  useCameraFrameOnScene(scene as MolScene | null, controlsRef.current, loading);

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
            onControlsStart();
            onOut();
            invalidate();
          }}
          onChange={onControlsChange}
          onEnd={onControlsEnd}
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
            <GridRaycast
              positions={filteredScene?.atoms?.positions}
              radii={filteredScene?.atoms?.radii}
              count={filteredScene?.atoms?.count ?? 0}
              radiusScale={spheres.radiusScale}
              bbox={filteredScene?.bbox as BBox | undefined}
              isCameraMovingRef={isCameraMoving}
              onHover={onHover}
              onOut={onOut}
            />
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
