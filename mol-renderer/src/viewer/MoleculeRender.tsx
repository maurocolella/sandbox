/*
 Title: MoleculeView
 Description: Top-level viewer component. Loads/parses a MolScene, manages chain filtering and UI controls,
 builds scene objects (atoms/bonds/backbone or ribbons), configures adaptive rendering, and wires a grid-
 accelerated raycaster to drive hover overlays without shader patching.
*/
import { Suspense, useEffect, useRef, useCallback, useMemo } from "react";
import { Canvas, invalidate } from "@react-three/fiber";
import { OrbitControls, AdaptiveDpr, Preload, StatsGl } from "@react-three/drei";
import type { MolScene } from "pdb-parser";
import { Color } from "three";
import { useFilteredScene } from "../lib/hooks/useFilteredScene";
import { useCameraFrameOnScene, type ControlsRef } from "../lib/hooks/useCameraFrameOnScene";
import { useSelectionLookups } from "../lib/hooks/useSelectionLookups";
import { useRenderKeys, type Representation } from "../lib/hooks/useRenderKeys";
import { useSceneObjects, type SceneBuildStatus } from "../lib/hooks/useSceneObjects";
import { useRibbonGroup } from "../lib/hooks/useRibbonGroup";
import type { RenderControls, OverlayControls } from "./types";
import { useHoverOverlays } from "../lib/hooks/useHoverOverlays";
import { useHoverState } from "../lib/hooks/useHoverState";
import { useCameraMotion } from "../lib/hooks/useCameraMotion";
import { AtomRaycast } from "./AtomRaycast";
import { SurfaceLayer, type SurfaceData } from "./SurfaceLayer";
import { PocketLayer, type PocketMesh } from "./PocketLayer";
import { LigandLayer, type LigandRef } from "./LigandLayer";
import { InteractionLayer } from "./InteractionLayer";
import type { Interaction } from "../lib/interactions";
import { CameraLights } from "./CameraLights";
import { RenderStats, type RenderStatsInfo } from "./RenderStats";
import { InstancesLod } from "./InstancesLod";

interface MoleculeRenderProps {
  background: string;
  renderControls: RenderControls;
  overlayControls: OverlayControls;
  scene: MolScene | null;
  visibleChains: number[];
  surfaceData?: SurfaceData | null; // kept on screen until a replacement is ready
  surfaceWireframe?: boolean;
  surfaceOpacity?: number; // 0..1, 1 = opaque
  /** Ligand-polymer interactions to draw. */
  interactions?: Interaction[] | null;
  /** Called when a ligand's label is clicked. */
  onLigandClick?: (ligand: LigandRef) => void;
  /** Pockets drawn as translucent volumes. */
  pockets?: PocketMesh[] | null;
  /** Called when the triangles / draw calls of the last frame change. */
  onRenderStats?: (stats: RenderStatsInfo) => void;
  /** Show the stats-gl panel (FPS, CPU and GPU frame time), positioned by className or placed inside parent. */
  stats?: { className?: string; parent?: React.RefObject<HTMLElement> } | false;
  /** Render every frame instead of on demand (for measuring sustained FPS). */
  continuousRender?: boolean;
  /** Called as atoms and bonds are built (in workers) and uploaded; null once everything is drawn. */
  onBuildStatus?: (status: SceneBuildStatus | null) => void;
}

export function MoleculeRender(props: MoleculeRenderProps) {
  const materialKind: "basic" | "lambert" | "standard" = "standard";
  const ribbonThickness = 0.18;

  // Filtered scene derived internally from scene + visibleChains
  const { filtered: filteredScene, selectionKey } = useFilteredScene(props.scene as MolScene | null, props.visibleChains);

  // Options are memoized: a new object on every render would rebuild all atoms and bonds each time
  const showSphereAtoms = props.renderControls.showAtoms && props.renderControls.renderMode === "spheres";
  const showSphereBackbone = props.renderControls.showBackbone && props.renderControls.renderMode === "spheres";
  const atomOptions = useMemo(
    () => (showSphereAtoms ? { materialKind, radiusScale: props.renderControls.radiusScale } : false as const),
    [showSphereAtoms, props.renderControls.radiusScale],
  );
  // Backbone lines contrast with the background
  const lightBackground = new Color(props.background).getHSL({ h: 0, s: 0, l: 0 }).l > 0.5;
  const backboneOptions = useMemo(() => (showSphereBackbone ? { color: lightBackground ? 0x3f3f46 : 0xffffff } : false as const), [showSphereBackbone, lightBackground]);
  const objects = useSceneObjects(filteredScene, {
    atoms: atomOptions,
    bonds: props.renderControls.showBonds,
    backbone: backboneOptions,
  });
  const onBuildStatus = props.onBuildStatus;
  useEffect(() => { onBuildStatus?.(objects.status); }, [objects.status, onBuildStatus]);

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
    sphereDetail: 16,
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

  // Ensure the backbone does not steal pointer events (atoms/bonds disable raycasting themselves)
  useEffect(() => {
    if (objects.backbone) {
      (objects.backbone as unknown as { raycast?: (...args: unknown[]) => void }).raycast = () => { };
    }
  }, [objects.backbone]);

  const controlsRef = useRef<ControlsRef | null>(null);
  // Camera frame hook on ORIGINAL scene (decoupled from chain visibility)
  useCameraFrameOnScene(props.scene as MolScene | null, controlsRef.current, false);

  return (
    <Canvas
      frameloop={props.continuousRender ? "always" : "demand"}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      dpr={[1, Math.min(window.devicePixelRatio || 1, 2)]}
      camera={{ position: [0, 0, 100], near: 0.1, far: 5000 }}
      onPointerLeave={handleCanvasPointerLeave}
    >
      <color attach="background" args={[props.background]} />
      <CameraLights />
      {props.stats && <StatsGl className={props.stats.className} parent={props.stats.parent} clearStatsGlStyle={!!props.stats.parent} trackGPU minimal />}
      {props.onRenderStats && <RenderStats onStats={props.onRenderStats} />}
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
          <SurfaceLayer data={props.surfaceData ?? null} wireframe={props.surfaceWireframe ?? false} opacity={props.surfaceOpacity ?? 1} />
          <PocketLayer pockets={props.pockets ?? null} />
          <InteractionLayer interactions={props.interactions ?? null} />
          {props.renderControls.showLigands && <LigandLayer scene={filteredScene} radiusScale={props.renderControls.radiusScale} onLigandClick={props.onLigandClick} />}
          {props.renderControls.renderMode !== "spheres" && (
            <>
              {ribbonGroup && <primitive key={keys.ribbon} object={ribbonGroup} />}
              {props.renderControls.showBonds && objects.bonds && (
                <InstancesLod key={keys.bonds} set={objects.bonds} onDrawn={objects.bondsDrawn} />
              )}
            </>
          )}
          {props.renderControls.renderMode === "spheres" && (
            <>
              {props.renderControls.showAtoms && objects.atoms && (
                <InstancesLod key={keys.atoms} set={objects.atoms} onDrawn={objects.atomsDrawn} />
              )}
              {props.renderControls.showBonds && objects.bonds && <InstancesLod key={keys.bonds} set={objects.bonds} onDrawn={objects.bondsDrawn} />}
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
          <AtomRaycast
            atoms={objects.atoms}
            isCameraMovingRef={isCameraMoving}
            onHover={onHover}
            onOut={onOut}
          />
        )}
      </Suspense>
    </Canvas>
  );
}
