import { useEffect, useMemo, useRef } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OutlinePass } from "three/examples/jsm/postprocessing/OutlinePass.js";
import * as THREE from "three";

export interface OutlineComposerProps {
  enabled: boolean;
  selected: THREE.Object3D[];
  params?: {
    edgeStrength?: number;
    edgeGlow?: number;
    edgeThickness?: number;
    pulsePeriod?: number;
    visibleEdgeColor?: number | string;
    hiddenEdgeColor?: number | string;
  };
}

export function OutlineComposer({ enabled, selected, params }: OutlineComposerProps) {
  const { gl, scene, camera, size } = useThree();
  const composerRef = useRef<EffectComposer | null>(null);
  const outlineRef = useRef<OutlinePass | null>(null);

  const target = useMemo(() => new THREE.WebGLRenderTarget(size.width, size.height, { samples: 4 }), [size.width, size.height]);

  useEffect(() => {
    const composer = new EffectComposer(gl, target);
    const renderPass = new RenderPass(scene, camera);
    const outline = new OutlinePass(new THREE.Vector2(size.width, size.height), scene, camera, selected);

    outline.edgeStrength = params?.edgeStrength ?? 4.0;
    outline.edgeGlow = params?.edgeGlow ?? 0.0;
    outline.edgeThickness = params?.edgeThickness ?? 1.0;
    outline.pulsePeriod = params?.pulsePeriod ?? 0;
    outline.visibleEdgeColor.set(params?.visibleEdgeColor ?? 0xff00ff);
    outline.hiddenEdgeColor.set(params?.hiddenEdgeColor ?? 0x000000);

    composer.addPass(renderPass);
    composer.addPass(outline);

    composerRef.current = composer;
    outlineRef.current = outline;

    return () => {
      composerRef.current = null;
      outlineRef.current = null;
      composer.dispose();
      target.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera, size.width, size.height]);

  // Update selected objects and params on change
  useEffect(() => {
    if (!outlineRef.current) return;
    outlineRef.current.selectedObjects = selected;
    if (params?.visibleEdgeColor != null) outlineRef.current.visibleEdgeColor.set(params.visibleEdgeColor as number);
    if (params?.hiddenEdgeColor != null) outlineRef.current.hiddenEdgeColor.set(params.hiddenEdgeColor as number);
    if (params?.edgeStrength != null) outlineRef.current.edgeStrength = params.edgeStrength;
    if (params?.edgeGlow != null) outlineRef.current.edgeGlow = params.edgeGlow;
    if (params?.edgeThickness != null) outlineRef.current.edgeThickness = params.edgeThickness;
    if (params?.pulsePeriod != null) outlineRef.current.pulsePeriod = params.pulsePeriod;
  }, [selected, params]);

  useFrame(() => {
    if (!enabled) return;
    const comp = composerRef.current;
    if (comp) comp.render();
  }, 1);

  return null;
}
