import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import type { MolScene } from "pdb-parser";

export type HoverGranularity = "atom" | "residue" | "chain";

export interface HoverHandlers {
  onPointerMove: (e: ThreeEvent<PointerEvent>) => void;
  onPointerOut: () => void;
  hovered: number;
}

export function useHoverHighlight(
  scene: MolScene | null,
  atoms: THREE.InstancedMesh | undefined,
  mode: HoverGranularity,
  tint: THREE.ColorRepresentation = 0xff00ff,
  enabled: boolean = true,
  eventsEnabled: boolean = true
): HoverHandlers {
  const hoveredRef = useRef<number>(-1);
  const [hovered, setHovered] = useState<number>(-1);
  const tintColor = useMemo(() => new THREE.Color(tint), [tint]);
  const uniformsRef = useRef<{ uHoveredIndex: { value: number }; uTint: { value: THREE.Color } } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!scene || !atoms) return;

    const count = scene.atoms.count;
    const ibg = atoms.geometry as THREE.InstancedBufferGeometry;

    if (mode === "residue" && !scene.atoms.residueIndex) return;
    if (mode === "chain" && !scene.atoms.chainIndex) return;

    const existing = ibg.getAttribute("aIndex") as THREE.InstancedBufferAttribute | undefined;
    if (!existing || existing.count !== count) {
      const a = new Float32Array(count);
      if (mode === "atom") {
        for (let i = 0; i < count; i++) a[i] = i;
      } else if (mode === "residue") {
        const ri = scene.atoms.residueIndex!;
        for (let i = 0; i < count; i++) a[i] = ri[i] as number;
      } else {
        const ci = scene.atoms.chainIndex!;
        for (let i = 0; i < count; i++) a[i] = ci[i] as number;
      }
      const attr = new THREE.InstancedBufferAttribute(a, 1);
      ibg.setAttribute("aIndex", attr);
    }

    uniformsRef.current = {
      uHoveredIndex: { value: hoveredRef.current },
      uTint: { value: tintColor.clone() },
    };

    const mat = atoms.material as THREE.MeshStandardMaterial | THREE.MeshLambertMaterial | THREE.MeshBasicMaterial;
    const orig = mat.onBeforeCompile as unknown as ((shader: unknown, renderer: unknown) => void) | undefined;
    mat.onBeforeCompile = (shader: unknown, renderer: unknown) => {
      const s = shader as { uniforms: { [key: string]: unknown }; vertexShader: string; fragmentShader: string };
      s.uniforms.uHoveredIndex = uniformsRef.current!.uHoveredIndex;
      s.uniforms.uTint = uniformsRef.current!.uTint;

      s.vertexShader = s.vertexShader
        .replace(
          "#include <common>",
          `#include <common>\nattribute float aIndex;\nvarying float vIndex;`
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\n vIndex = aIndex;`
        );

      s.fragmentShader = s.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>\nvarying float vIndex;\nuniform float uHoveredIndex;\nuniform vec3 uTint;`
        );

      if (s.fragmentShader.includes("gl_FragColor = vec4( outgoingLight, diffuseColor.a );")) {
        s.fragmentShader = s.fragmentShader.replace(
          "gl_FragColor = vec4( outgoingLight, diffuseColor.a );",
          `vec3 mixedColor = outgoingLight;\nif (abs(vIndex - uHoveredIndex) < 0.5) { mixedColor = mix(outgoingLight, uTint, 0.6); }\ngl_FragColor = vec4( mixedColor, diffuseColor.a );`
        );
      } else if (s.fragmentShader.includes("#include <dithering_fragment>")) {
        s.fragmentShader = s.fragmentShader.replace(
          "#include <dithering_fragment>",
          `if (abs(vIndex - uHoveredIndex) < 0.5) { gl_FragColor.rgb = mix(gl_FragColor.rgb, uTint, 0.6); }\n#include <dithering_fragment>`
        );
      }

      if (typeof orig === "function") orig.call(mat, shader, renderer);
    };

    mat.needsUpdate = true;

    return () => {
      mat.onBeforeCompile = orig as unknown as (typeof mat)["onBeforeCompile"];
      mat.needsUpdate = true;
    };
  }, [scene, atoms, tintColor, enabled, mode]);

  useEffect(() => {
    if (!enabled) {
      hoveredRef.current = -1;
      setHovered(-1);
      if (uniformsRef.current) uniformsRef.current.uHoveredIndex.value = -1;
    }
  }, [enabled]);

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (!eventsEnabled) return;
    if (!scene || !atoms) return;
    const id = e.instanceId;
    if (id == null) return;
    let idx = -1;
    if (mode === "atom") {
      idx = id;
    } else if (mode === "residue") {
      const ri = scene.atoms.residueIndex ? scene.atoms.residueIndex[id] : undefined;
      if (ri == null) return;
      idx = ri as number;
    } else {
      const ci = scene.atoms.chainIndex ? scene.atoms.chainIndex[id] : undefined;
      if (ci == null) return;
      idx = ci as number;
    }
    if (hoveredRef.current !== idx) {
      hoveredRef.current = idx;
      setHovered(idx);
      if (uniformsRef.current) uniformsRef.current.uHoveredIndex.value = idx;
    }
  };

  const onPointerOut = () => {
    if (!eventsEnabled) return;
    if (hoveredRef.current !== -1) {
      hoveredRef.current = -1;
      setHovered(-1);
      if (uniformsRef.current) uniformsRef.current.uHoveredIndex.value = -1;
    }
  };

  return { onPointerMove, onPointerOut, hovered };
}
