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
import type { RenderRepresentation } from "./types";
import { useHoverOverlays } from "../lib/hooks/useHoverOverlays";
import { useHoverState } from "../lib/hooks/useHoverState";
import { useCameraMotion } from "../lib/hooks/useCameraMotion";
import { useRendererControls } from "../lib/hooks/useRendererControls";
import { GridRaycast, type BBox } from "./GridRaycast";

interface MoleculeRenderProps {
  background: string;
  representation: RenderRepresentation;
  showAtoms: boolean;
  showBonds: boolean;
  showBackbone: boolean;
  overlay: unknown;
  scene: MolScene | null;
  visibleChains: number[];
}

export function MoleculeRender(props: MoleculeRenderProps) {
  const { spheres, selection, style, ribbon } = useRendererControls() as unknown as {
    spheres: { radiusScale: number; sphereDetail: number };
    selection: { mode: string; hoverTint: string; onTopHighlight: boolean };
    style: { materialKind: "basic" | "lambert" | "standard"; background: string };
    ribbon: { thickness: number };
  };

  // Filtered scene derived internally from scene + visibleChains
  const { filtered: filteredScene, selectionKey } = useFilteredScene(props.scene as MolScene | null, props.visibleChains);

  const objects = useSceneObjects(filteredScene, {
    atoms: props.showAtoms && props.representation === "spheres"
      ? { sphereDetail: spheres.sphereDetail, materialKind: style.materialKind, radiusScale: spheres.radiusScale }
      : false,
    bonds: props.showBonds,
    backbone: props.showBackbone && props.representation === "spheres" ? {} : false,
  });

  const ribbonGroup = useRibbonGroup(
    filteredScene,
    props.representation as "spheres" | "ribbon-tube" | "ribbon-flat",
    style.materialKind,
    { thickness: ribbon.thickness }
  );

  // Hover state via hook (no shader patching)
  const isSpheres = props.representation === "spheres";
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

  // Ribbon group is provided via props.objects.ribbon (cached in MainView)

  // Render keys (derived from selection + overlays + representation)
  const keys = useRenderKeys(selectionKey, props.representation as Representation, {
    atoms: props.showAtoms,
    bonds: props.showBonds,
    backbone: props.showBackbone,
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
          {props.representation !== "spheres" && ribbonGroup && (
            <>
              <primitive key={keys.ribbon} object={ribbonGroup} />
              {props.showBonds && objects.bonds && (
                <primitive key={keys.bonds} object={objects.bonds} />
              )}
              {props.showBackbone && objects.backbone && <primitive key={keys.backbone} object={objects.backbone} />}
            </>
          )}
          {props.representation === "spheres" && (
            <>
              {props.showAtoms && objects.atoms && (
                <primitive
                  key={keys.atoms}
                  object={objects.atoms}
                />
              )}
              {props.showBonds && objects.bonds && <primitive key={keys.bonds} object={objects.bonds} />}
              {props.showBackbone && objects.backbone && <primitive key={keys.backbone} object={objects.backbone} />}
              {isSpheres && hoverAtomOverlay && (
                <primitive key="hover-atom-overlay" object={hoverAtomOverlay} />
              )}
              {isSpheres && hoverBondOverlay && (
                <primitive key="hover-bond-overlay" object={hoverBondOverlay} />
              )}
            </>
          )}
        </group>
        {props.representation === "spheres" && props.showAtoms && (
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
  );
}
