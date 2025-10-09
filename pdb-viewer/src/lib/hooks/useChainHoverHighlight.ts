import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import type { MolScene } from "pdb-parser";

interface ShaderUniforms {
  [key: string]: unknown;
  uHoveredChain?: { value: number };
  uTint?: { value: THREE.Color };
}

interface ShaderLike {
  uniforms: ShaderUniforms;
  vertexShader: string;
  fragmentShader: string;
}

type OnBeforeCompileFn = (shader: unknown, renderer: unknown) => void;

export interface ChainHoverHandlers {
  onPointerMove: (e: ThreeEvent<PointerEvent>) => void;
  onPointerOut: () => void;
}

export function useChainHoverHighlight(
  scene: MolScene | null,
  atoms: THREE.InstancedMesh | undefined,
  tint: THREE.ColorRepresentation = 0xff00ff
): ChainHoverHandlers {
  const hoveredChainRef = useRef<number>(-1);
  const tintColor = useMemo(() => new THREE.Color(tint), [tint]);
  const uniformsRef = useRef<{ uHoveredChain: { value: number }; uTint: { value: THREE.Color } } | null>(null);

  // Attach per-instance chain attribute and inject shader
  useEffect(() => {
    if (!scene || !atoms) return;
    if (!scene.atoms.chainIndex) return;

    const count = scene.atoms.count;
    // Attach aChain attribute if missing or wrong length
    const existing = (atoms.geometry as THREE.InstancedBufferGeometry).getAttribute("aChain") as THREE.InstancedBufferAttribute | undefined;
    if (!existing || existing.count !== count) {
      const a = new Float32Array(count);
      for (let i = 0; i < count; i++) a[i] = scene.atoms.chainIndex![i] as number;
      const attr = new THREE.InstancedBufferAttribute(a, 1);
      (atoms.geometry as THREE.InstancedBufferGeometry).setAttribute("aChain", attr);
    }

    // Prepare uniforms
    uniformsRef.current = {
      uHoveredChain: { value: hoveredChainRef.current },
      uTint: { value: tintColor.clone() },
    };

    const mat = atoms.material as THREE.MeshStandardMaterial | THREE.MeshLambertMaterial | THREE.MeshBasicMaterial;
    const orig = mat.onBeforeCompile as unknown as OnBeforeCompileFn | undefined;
    mat.onBeforeCompile = (shader: unknown, renderer: unknown) => {
      const s = shader as ShaderLike;
      // attach uniforms
      s.uniforms.uHoveredChain = uniformsRef.current!.uHoveredChain;
      s.uniforms.uTint = uniformsRef.current!.uTint;

      // vertex: declare attribute + varying
      s.vertexShader = s.vertexShader
        .replace(
          "#include <common>",
          `#include <common>\nattribute float aChain;\nvarying float vChain;`
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\n vChain = aChain;`
        );

      // fragment: declare uniforms and varyings
      s.fragmentShader = s.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>\nvarying float vChain;\nuniform float uHoveredChain;\nuniform vec3 uTint;`
        );

      // robust replacement for final color application across materials
      if (s.fragmentShader.includes("gl_FragColor = vec4( outgoingLight, diffuseColor.a );")) {
        s.fragmentShader = s.fragmentShader.replace(
          "gl_FragColor = vec4( outgoingLight, diffuseColor.a );",
          `vec3 mixedColor = outgoingLight;\nif (abs(vChain - uHoveredChain) < 0.5) { mixedColor = mix(outgoingLight, uTint, 0.6); }\ngl_FragColor = vec4( mixedColor, diffuseColor.a );`
        );
      } else if (s.fragmentShader.includes("#include <dithering_fragment>")) {
        s.fragmentShader = s.fragmentShader.replace(
          "#include <dithering_fragment>",
          `vec3 mixedColor = outgoingLight;\nif (abs(vChain - uHoveredChain) < 0.5) { mixedColor = mix(outgoingLight, uTint, 0.6); }\ngl_FragColor = vec4( mixedColor, diffuseColor.a );\n#include <dithering_fragment>`
        );
      }

      // call original if present
      if (typeof orig === "function") {
        orig.call(mat, shader, renderer);
      }
    };

    // ensure material recompiles
    mat.needsUpdate = true;
  }, [scene, atoms, tintColor]);

  // Handlers
  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!scene || !atoms) return;
    const id = e.instanceId;
    if (id == null) return;
    const ci = scene.atoms.chainIndex ? scene.atoms.chainIndex[id] : undefined;
    if (ci == null) return;
    if (hoveredChainRef.current !== ci) {
      hoveredChainRef.current = ci;
      if (uniformsRef.current) uniformsRef.current.uHoveredChain.value = ci;
    }
  };

  const onPointerOut = () => {
    if (hoveredChainRef.current !== -1) {
      hoveredChainRef.current = -1;
      if (uniformsRef.current) uniformsRef.current.uHoveredChain.value = -1;
    }
  };

  return { onPointerMove, onPointerOut };
}
