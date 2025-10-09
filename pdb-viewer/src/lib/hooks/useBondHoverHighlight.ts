import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import type { MolScene } from "pdb-parser";

interface ShaderUniforms {
  [key: string]: unknown;
  uHoveredBond?: { value: number };
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
}

export function useBondHoverHighlight(
  scene: MolScene | null,
  bonds: THREE.InstancedMesh | undefined,
  tint: THREE.ColorRepresentation = 0xff00ff,
  enabled: boolean = true
): HoverHandlers {
  const hoveredBondRef = useRef<number>(-1);
  const tintColor = useMemo(() => new THREE.Color(tint), [tint]);
  const uniformsRef = useRef<{ uHoveredBond: { value: number }; uTint: { value: THREE.Color } } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!scene || !bonds) return;
    if (!scene.bonds) return;

    const count = scene.bonds.count;
    const ibg = bonds.geometry as THREE.InstancedBufferGeometry;
    const existing = ibg.getAttribute("aBondIndex") as THREE.InstancedBufferAttribute | undefined;
    if (!existing || existing.count !== count) {
      const a = new Float32Array(count);
      for (let i = 0; i < count; i++) a[i] = i;
      const attr = new THREE.InstancedBufferAttribute(a, 1);
      ibg.setAttribute("aBondIndex", attr);
    }

    uniformsRef.current = {
      uHoveredBond: { value: hoveredBondRef.current },
      uTint: { value: tintColor.clone() },
    };

    const mat = bonds.material as THREE.MeshStandardMaterial | THREE.MeshLambertMaterial | THREE.MeshBasicMaterial;
    const orig = mat.onBeforeCompile as unknown as OnBeforeCompileFn | undefined;
    mat.onBeforeCompile = (shader: unknown, renderer: unknown) => {
      const s = shader as ShaderLike;
      s.uniforms.uHoveredBond = uniformsRef.current!.uHoveredBond;
      s.uniforms.uTint = uniformsRef.current!.uTint;

      s.vertexShader = s.vertexShader
        .replace(
          "#include <common>",
          `#include <common>\nattribute float aBondIndex;\nvarying float vBondIndex;`
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\n vBondIndex = aBondIndex;`
        );

      s.fragmentShader = s.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>\nvarying float vBondIndex;\nuniform float uHoveredBond;\nuniform vec3 uTint;`
        );

      if (s.fragmentShader.includes("gl_FragColor = vec4( outgoingLight, diffuseColor.a );")) {
        s.fragmentShader = s.fragmentShader.replace(
          "gl_FragColor = vec4( outgoingLight, diffuseColor.a );",
          `vec3 mixedColor = outgoingLight;\nif (abs(vBondIndex - uHoveredBond) < 0.5) { mixedColor = mix(outgoingLight, uTint, 0.6); }\ngl_FragColor = vec4( mixedColor, diffuseColor.a );`
        );
      } else if (s.fragmentShader.includes("#include <dithering_fragment>")) {
        s.fragmentShader = s.fragmentShader.replace(
          "#include <dithering_fragment>",
          `vec3 mixedColor = outgoingLight;\nif (abs(vBondIndex - uHoveredBond) < 0.5) { mixedColor = mix(outgoingLight, uTint, 0.6); }\ngl_FragColor = vec4( mixedColor, diffuseColor.a );\n#include <dithering_fragment>`
        );
      }

      if (typeof orig === "function") orig.call(mat, shader, renderer);
    };

    mat.needsUpdate = true;

    return () => {
      mat.onBeforeCompile = orig as unknown as (typeof mat)["onBeforeCompile"];
      mat.needsUpdate = true;
    };
  }, [scene, bonds, tintColor, enabled]);

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!enabled) return;
    if (!scene || !bonds) return;
    const id = e.instanceId;
    if (id == null) return;
    if (hoveredBondRef.current !== id) {
      hoveredBondRef.current = id;
      if (uniformsRef.current) uniformsRef.current.uHoveredBond.value = id;
    }
  };

  const onPointerOut = () => {
    if (!enabled) return;
    if (hoveredBondRef.current !== -1) {
      hoveredBondRef.current = -1;
      if (uniformsRef.current) uniformsRef.current.uHoveredBond.value = -1;
    }
  };

  return { onPointerMove, onPointerOut };
}
