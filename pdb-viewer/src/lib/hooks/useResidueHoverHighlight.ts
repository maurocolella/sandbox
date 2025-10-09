import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import type { MolScene } from "pdb-parser";

interface ShaderUniforms {
  [key: string]: unknown;
  uHoveredResidue?: { value: number };
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

export function useResidueHoverHighlight(
  scene: MolScene | null,
  atoms: THREE.InstancedMesh | undefined,
  tint: THREE.ColorRepresentation = 0xff00ff,
  enabled: boolean = true
): HoverHandlers {
  const hoveredResidueRef = useRef<number>(-1);
  const tintColor = useMemo(() => new THREE.Color(tint), [tint]);
  const uniformsRef = useRef<{ uHoveredResidue: { value: number }; uTint: { value: THREE.Color } } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!scene || !atoms) return;
    if (!scene.atoms.residueIndex) return;

    const count = scene.atoms.count;
    const ibg = atoms.geometry as THREE.InstancedBufferGeometry;
    const existing = ibg.getAttribute("aResidue") as THREE.InstancedBufferAttribute | undefined;
    if (!existing || existing.count !== count) {
      const a = new Float32Array(count);
      for (let i = 0; i < count; i++) a[i] = scene.atoms.residueIndex![i] as number;
      const attr = new THREE.InstancedBufferAttribute(a, 1);
      ibg.setAttribute("aResidue", attr);
    }

    uniformsRef.current = {
      uHoveredResidue: { value: hoveredResidueRef.current },
      uTint: { value: tintColor.clone() },
    };

    const mat = atoms.material as THREE.MeshStandardMaterial | THREE.MeshLambertMaterial | THREE.MeshBasicMaterial;
    const orig = mat.onBeforeCompile as unknown as OnBeforeCompileFn | undefined;
    mat.onBeforeCompile = (shader: unknown, renderer: unknown) => {
      const s = shader as ShaderLike;
      s.uniforms.uHoveredResidue = uniformsRef.current!.uHoveredResidue;
      s.uniforms.uTint = uniformsRef.current!.uTint;

      s.vertexShader = s.vertexShader
        .replace(
          "#include <common>",
          `#include <common>\nattribute float aResidue;\nvarying float vResidue;`
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\n vResidue = aResidue;`
        );

      s.fragmentShader = s.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>\nvarying float vResidue;\nuniform float uHoveredResidue;\nuniform vec3 uTint;`
        );

      if (s.fragmentShader.includes("gl_FragColor = vec4( outgoingLight, diffuseColor.a );")) {
        s.fragmentShader = s.fragmentShader.replace(
          "gl_FragColor = vec4( outgoingLight, diffuseColor.a );",
          `vec3 mixedColor = outgoingLight;\nif (abs(vResidue - uHoveredResidue) < 0.5) { mixedColor = mix(outgoingLight, uTint, 0.6); }\ngl_FragColor = vec4( mixedColor, diffuseColor.a );`
        );
      } else if (s.fragmentShader.includes("#include <dithering_fragment>")) {
        s.fragmentShader = s.fragmentShader.replace(
          "#include <dithering_fragment>",
          `vec3 mixedColor = outgoingLight;\nif (abs(vResidue - uHoveredResidue) < 0.5) { mixedColor = mix(outgoingLight, uTint, 0.6); }\ngl_FragColor = vec4( mixedColor, diffuseColor.a );\n#include <dithering_fragment>`
        );
      }

      if (typeof orig === "function") orig.call(mat, shader, renderer);
    };

    mat.needsUpdate = true;
  }, [scene, atoms, tintColor, enabled]);

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!enabled) return;
    if (!scene || !atoms) return;
    const id = e.instanceId;
    if (id == null) return;
    const ri = scene.atoms.residueIndex ? scene.atoms.residueIndex[id] : undefined;
    if (ri == null) return;
    if (hoveredResidueRef.current !== ri) {
      hoveredResidueRef.current = ri;
      if (uniformsRef.current) uniformsRef.current.uHoveredResidue.value = ri;
    }
  };

  const onPointerOut = () => {
    if (!enabled) return;
    if (hoveredResidueRef.current !== -1) {
      hoveredResidueRef.current = -1;
      if (uniformsRef.current) uniformsRef.current.uHoveredResidue.value = -1;
    }
  };

  return { onPointerMove, onPointerOut };
}
