/*
 Title: MoleculeView
 Description: Top-level viewer component. Loads/parses a MolScene, manages chain filtering and UI controls,
 builds scene objects (atoms/bonds/backbone or ribbons), configures adaptive rendering, and wires a grid-
 accelerated raycaster to drive hover overlays without shader patching.
*/
import { Suspense, useEffect, useRef, useCallback } from "react";
import { Canvas, invalidate } from "@react-three/fiber";
import { OrbitControls, AdaptiveDpr, Preload } from "@react-three/drei";
import type { MolScene } from "pdb-parser";
import { useFilteredScene } from "../lib/hooks/useFilteredScene";
import { useCameraFrameOnScene, type ControlsRef } from "../lib/hooks/useCameraFrameOnScene";
import { useSelectionLookups } from "../lib/hooks/useSelectionLookups";
import { useRenderKeys, type Representation } from "../lib/hooks/useRenderKeys";
import { useSceneObjects } from "../lib/hooks/useSceneObjects";
import { useRibbonGroup } from "../lib/hooks/useRibbonGroup";
import type { RenderControls, OverlayControls } from "./types";
import { useHoverOverlays } from "../lib/hooks/useHoverOverlays";
import { useHoverState } from "../lib/hooks/useHoverState";
import { useCameraMotion } from "../lib/hooks/useCameraMotion";
import { GridRaycast, type BBox } from "./GridRaycast";
import type { Object3D } from "three";

interface MoleculeRenderProps {
  background: string;
  renderControls: RenderControls;
  overlayControls: OverlayControls;
  scene: MolScene | null;
  visibleChains: number[];
  surface?: Object3D | null;
}

export function MoleculeRender(props: MoleculeRenderProps) {
  const materialKind: "basic" | "lambert" | "standard" = "lambert";
  const ribbonThickness = 0.18;

  // Filtered scene derived internally from scene + visibleChains
  const { filtered: filteredScene, selectionKey } = useFilteredScene(props.scene as MolScene | null, props.visibleChains);

  const objects = useSceneObjects(filteredScene, {
    atoms: props.renderControls.showAtoms && props.renderControls.renderMode === "spheres"
      ? { sphereDetail: props.renderControls.sphereDetail, materialKind, radiusScale: props.renderControls.radiusScale }
      : false,
    bonds: props.renderControls.showBonds,
    backbone: props.renderControls.showBackbone && props.renderControls.renderMode === "spheres" ? {} : false,
  });

  const ribbonGroup = useRibbonGroup(
    filteredScene,
    props.renderControls.renderMode as "spheres" | "ribbon-tube" | "ribbon-flat",
    materialKind,
    { thickness: ribbonThickness }
  );

  // Hover state via hook (no shader patching)
  const isSpheres = props.renderControls.renderMode === "spheres";
  const effectiveMode = props.overlayControls.mode;
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
    hoveredAtom: props.overlayControls.mode === "atom" ? hoveredAtom : -1,
    hoveredResidue: props.overlayControls.mode === "residue" ? hoveredResidue : -1,
    hoveredChain: props.overlayControls.mode === "chain" ? hoveredChain : -1,
    color: props.overlayControls.hoverTint,
    radiusScale: props.renderControls.radiusScale,
    sphereDetail: props.renderControls.sphereDetail,
    onTop: props.overlayControls.onTopHighlight,
  }, lookups);

  // Ribbon group is provided via props.objects.ribbon (cached in MainView)

  // Render keys (derived from selection + overlays + representation)
  const keys = useRenderKeys(selectionKey, props.renderControls.renderMode as Representation, {
    atoms: props.renderControls.showAtoms,
    bonds: props.renderControls.showBonds,
    backbone: props.renderControls.showBackbone,
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
  useCameraFrameOnScene(props.scene as MolScene | null, controlsRef.current, false);

  return (
    <Canvas
      frameloop="demand"
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      dpr={[1, Math.min(window.devicePixelRatio || 1, 2)]}
      camera={{ position: [0, 0, 100], near: 0.1, far: 5000 }}
      onPointerLeave={handleCanvasPointerLeave}
    >
      <color attach="background" args={[props.background]} />
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
          {props.surface && <primitive key="surface" object={props.surface} />}
          {props.renderControls.renderMode !== "spheres" && ribbonGroup && (
            <>
              <primitive key={keys.ribbon} object={ribbonGroup} />
              {props.renderControls.showBonds && objects.bonds && (
                <primitive key={keys.bonds} object={objects.bonds} />
              )}
              {props.renderControls.showBackbone && objects.backbone && <primitive key={keys.backbone} object={objects.backbone} />}
            </>
          )}
          {props.renderControls.renderMode === "spheres" && (
            <>
              {props.renderControls.showAtoms && objects.atoms && (
                <primitive
                  key={keys.atoms}
                  object={objects.atoms}
                />
              )}
              {props.renderControls.showBonds && objects.bonds && <primitive key={keys.bonds} object={objects.bonds} />}
              {props.renderControls.showBackbone && objects.backbone && <primitive key={keys.backbone} object={objects.backbone} />}
              {isSpheres && hoverAtomOverlay && (
                <primitive key="hover-atom-overlay" object={hoverAtomOverlay} />
              )}
              {isSpheres && hoverBondOverlay && (
                <primitive key="hover-bond-overlay" object={hoverBondOverlay} />
              )}
            </>
          )}
        </group>
        {props.renderControls.renderMode === "spheres" && props.renderControls.showAtoms && (
          <GridRaycast
            positions={filteredScene?.atoms?.positions}
            radii={filteredScene?.atoms?.radii}
            count={filteredScene?.atoms?.count ?? 0}
            radiusScale={props.renderControls.radiusScale}
            bbox={filteredScene?.bbox as BBox | undefined}
            isCameraMovingRef={isCameraMoving}
            onHover={onHover}
            onOut={onOut}
          />
        )}
      </Suspense>
    </Canvas>
  );
}
