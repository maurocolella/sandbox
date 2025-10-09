import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { MolScene } from "pdb-parser";

interface ShaderUniforms {
  [key: string]: unknown;
  uHoveredChain?: { value: number };
  uHoveredResidue?: { value: number };
  uMode?: { value: number }; // 0=off, 1=chain, 2=residue
  uTint?: { value: THREE.Color };
}

interface ShaderLike {
  uniforms: ShaderUniforms;
  vertexShader: string;
  fragmentShader: string;
}

type OnBeforeCompileFn = (shader: unknown, renderer: unknown) => void;

export function useBondLinkedHoverHighlight(
  scene: MolScene | null,
  bonds: THREE.InstancedMesh | undefined,
  selectionMode: "atom" | "residue" | "chain",
  hoveredChainIndex: number,
  hoveredResidueIndex: number,
  tint: THREE.ColorRepresentation = 0xff00ff,
  enabled: boolean = true
): void {
  const tintColor = useMemo(() => new THREE.Color(tint), [tint]);
  const uniformsRef = useRef<
    { uHoveredChain: { value: number }; uHoveredResidue: { value: number }; uMode: { value: number }; uTint: { value: THREE.Color } }
  | null>(null);

  // Inject attributes and shader only once when enabled
  useEffect(() => {
    if (!enabled) return;
    if (!scene || !bonds || !scene.bonds) return;

    const count = scene.bonds.count;
    const ibg = bonds.geometry as THREE.InstancedBufferGeometry;

    const ensureAttr = (name: string, filler: (i: number) => number) => {
      const existing = ibg.getAttribute(name) as THREE.InstancedBufferAttribute | undefined;
      if (!existing || existing.count !== count) {
        const arr = new Float32Array(count);
        for (let i = 0; i < count; i++) arr[i] = filler(i);
        const attr = new THREE.InstancedBufferAttribute(arr, 1);
        ibg.setAttribute(name, attr);
      }
    };

    const indexA = scene.bonds.indexA;
    const indexB = scene.bonds.indexB;
    const chainIndex = scene.atoms.chainIndex;
    const residueIndex = scene.atoms.residueIndex;

    ensureAttr("aBondChainA", (i) => (chainIndex ? chainIndex[indexA[i]!]! : -1));
    ensureAttr("aBondChainB", (i) => (chainIndex ? chainIndex[indexB[i]!]! : -1));
    ensureAttr("aBondResidueA", (i) => (residueIndex ? residueIndex[indexA[i]!]! : -1));
    ensureAttr("aBondResidueB", (i) => (residueIndex ? residueIndex[indexB[i]!]! : -1));

    uniformsRef.current = {
      uHoveredChain: { value: hoveredChainIndex },
      uHoveredResidue: { value: hoveredResidueIndex },
      uMode: { value: selectionMode === "chain" ? 1 : selectionMode === "residue" ? 2 : 0 },
      uTint: { value: tintColor.clone() },
    };

    const mat = bonds.material as THREE.MeshStandardMaterial | THREE.MeshLambertMaterial | THREE.MeshBasicMaterial;
    const orig = mat.onBeforeCompile as unknown as OnBeforeCompileFn | undefined;
    mat.onBeforeCompile = (shader: unknown, renderer: unknown) => {
      const s = shader as ShaderLike;
      s.uniforms.uHoveredChain = uniformsRef.current!.uHoveredChain;
      s.uniforms.uHoveredResidue = uniformsRef.current!.uHoveredResidue;
      s.uniforms.uMode = uniformsRef.current!.uMode;
      s.uniforms.uTint = uniformsRef.current!.uTint;

      s.vertexShader = s.vertexShader
        .replace(
          "#include <common>",
          `#include <common>\nattribute float aBondChainA;\nattribute float aBondChainB;\nattribute float aBondResidueA;\nattribute float aBondResidueB;\nvarying float vBondChainA;\nvarying float vBondChainB;\nvarying float vBondResidueA;\nvarying float vBondResidueB;`
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\n vBondChainA = aBondChainA;\n vBondChainB = aBondChainB;\n vBondResidueA = aBondResidueA;\n vBondResidueB = aBondResidueB;`
        );

      s.fragmentShader = s.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>\nvarying float vBondChainA;\nvarying float vBondChainB;\nvarying float vBondResidueA;\nvarying float vBondResidueB;\nuniform float uHoveredChain;\nuniform float uHoveredResidue;\nuniform float uMode;\nuniform vec3 uTint;`
        );

      const mixLogic = `
        float h = 0.0;\n
        if (abs(uMode - 1.0) < 0.5) {\n          if (abs(vBondChainA - uHoveredChain) < 0.5 || abs(vBondChainB - uHoveredChain) < 0.5) h = 1.0;\n        } else if (abs(uMode - 2.0) < 0.5) {\n          if (abs(vBondResidueA - uHoveredResidue) < 0.5 || abs(vBondResidueB - uHoveredResidue) < 0.5) h = 1.0;\n        }\n
        vec3 mixedColor = outgoingLight;\n        if (h > 0.5) { mixedColor = mix(outgoingLight, uTint, 0.6); }
      `;

      if (s.fragmentShader.includes("gl_FragColor = vec4( outgoingLight, diffuseColor.a );")) {
        s.fragmentShader = s.fragmentShader.replace(
          "gl_FragColor = vec4( outgoingLight, diffuseColor.a );",
          `${mixLogic}\n gl_FragColor = vec4( mixedColor, diffuseColor.a );`
        );
      } else if (s.fragmentShader.includes("#include <dithering_fragment>")) {
        s.fragmentShader = s.fragmentShader.replace(
          "#include <dithering_fragment>",
          `${mixLogic}\n gl_FragColor = vec4( mixedColor, diffuseColor.a );\n#include <dithering_fragment>`
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

  // Update uniforms when hovered state or mode changes
  useEffect(() => {
    if (!uniformsRef.current) return;
    uniformsRef.current.uHoveredChain.value = hoveredChainIndex;
    uniformsRef.current.uHoveredResidue.value = hoveredResidueIndex;
    uniformsRef.current.uMode.value = selectionMode === "chain" ? 1 : selectionMode === "residue" ? 2 : 0;
  }, [hoveredChainIndex, hoveredResidueIndex, selectionMode]);
}
