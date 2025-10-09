import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import type { MolScene } from "pdb-parser";

interface ShaderUniforms {
  [key: string]: unknown;
  uHoveredAtom?: { value: number };
  uTint?: { value: THREE.Color };
}

interface ShaderLike {
  uniforms: ShaderUniforms;
  vertexShader: string;
  fragmentShader: string;
}

type OnBeforeCompileFn = (shader: unknown, renderer: unknown) => void;

export interface HoverHandlers {
  onPointerMove: (e: ThreeEvent<PointerEvent>) => void;
  onPointerOut: () => void;
  hovered?: number;
}

export function useAtomHoverHighlight(
  scene: MolScene | null,
  atoms: THREE.InstancedMesh | undefined,
  tint: THREE.ColorRepresentation = 0xff00ff,
  enabled: boolean = true,
  eventsEnabled: boolean = true
): HoverHandlers {
  const hoveredAtomRef = useRef<number>(-1);
  const [hovered, setHovered] = useState<number>(-1);
  const tintColor = useMemo(() => new THREE.Color(tint), [tint]);
  const uniformsRef = useRef<{ uHoveredAtom: { value: number }; uTint: { value: THREE.Color } } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!scene || !atoms) return;

    const count = scene.atoms.count;
    const ibg = atoms.geometry as THREE.InstancedBufferGeometry;
    const existing = ibg.getAttribute("aAtomIndex") as THREE.InstancedBufferAttribute | undefined;
    if (!existing || existing.count !== count) {
      const a = new Float32Array(count);
      for (let i = 0; i < count; i++) a[i] = i;
      const attr = new THREE.InstancedBufferAttribute(a, 1);
      ibg.setAttribute("aAtomIndex", attr);
    }

    uniformsRef.current = {
      uHoveredAtom: { value: hoveredAtomRef.current },
      uTint: { value: tintColor.clone() },
    };

    const mat = atoms.material as THREE.MeshStandardMaterial | THREE.MeshLambertMaterial | THREE.MeshBasicMaterial;
    const orig = mat.onBeforeCompile as unknown as OnBeforeCompileFn | undefined;
    mat.onBeforeCompile = (shader: unknown, renderer: unknown) => {
      const s = shader as ShaderLike;
      s.uniforms.uHoveredAtom = uniformsRef.current!.uHoveredAtom;
      s.uniforms.uTint = uniformsRef.current!.uTint;

      s.vertexShader = s.vertexShader
        .replace(
          "#include <common>",
          `#include <common>\nattribute float aAtomIndex;\nvarying float vAtomIndex;`
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\n vAtomIndex = aAtomIndex;`
        );

      s.fragmentShader = s.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>\nvarying float vAtomIndex;\nuniform float uHoveredAtom;\nuniform vec3 uTint;`
        );

      if (s.fragmentShader.includes("gl_FragColor = vec4( outgoingLight, diffuseColor.a );")) {
        s.fragmentShader = s.fragmentShader.replace(
          "gl_FragColor = vec4( outgoingLight, diffuseColor.a );",
          `vec3 mixedColor = outgoingLight;\nif (abs(vAtomIndex - uHoveredAtom) < 0.5) { mixedColor = mix(outgoingLight, uTint, 0.6); }\ngl_FragColor = vec4( mixedColor, diffuseColor.a );`
        );
      } else if (s.fragmentShader.includes("#include <dithering_fragment>")) {
        s.fragmentShader = s.fragmentShader.replace(
          "#include <dithering_fragment>",
          `vec3 mixedColor = outgoingLight;\nif (abs(vAtomIndex - uHoveredAtom) < 0.5) { mixedColor = mix(outgoingLight, uTint, 0.6); }\ngl_FragColor = vec4( mixedColor, diffuseColor.a );\n#include <dithering_fragment>`
        );
      }

      if (typeof orig === "function") orig.call(mat, shader, renderer);
    };

    mat.needsUpdate = true;

    return () => {
      mat.onBeforeCompile = orig as unknown as (typeof mat)["onBeforeCompile"];
      mat.needsUpdate = true;
    };
  }, [scene, atoms, tintColor, enabled]);

  // If disabled, ensure hover state is cleared
  useEffect(() => {
    if (!enabled) {
      hoveredAtomRef.current = -1;
      setHovered(-1);
      if (uniformsRef.current) uniformsRef.current.uHoveredAtom.value = -1;
    }
  }, [enabled]);

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (!eventsEnabled) return;
    if (!scene || !atoms) return;
    const id = e.instanceId;
    if (id == null) return;
    if (hoveredAtomRef.current !== id) {
      hoveredAtomRef.current = id;
      setHovered(id);
      if (uniformsRef.current) uniformsRef.current.uHoveredAtom.value = id;
    }
  };

  const onPointerOut = () => {
    if (!eventsEnabled) return;
    if (hoveredAtomRef.current !== -1) {
      hoveredAtomRef.current = -1;
      setHovered(-1);
      if (uniformsRef.current) uniformsRef.current.uHoveredAtom.value = -1;
    }
  };

  return { onPointerMove, onPointerOut, hovered };
}
