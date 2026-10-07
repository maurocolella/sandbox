/*
 Title: PocketLayer
 Description: Pockets as translucent volumes, one colour each. Like SurfaceLayer, each draws a depth-only
 prepass, then its colour with depthFunc LessEqual, so only its front-most layer shows (no sorting artefacts
 within a mesh); both sit in the transparent queue, after the opaque molecule.
*/
import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";

export interface PocketMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  color: THREE.ColorRepresentation;
}

const OPACITY = 0.55;

export function PocketLayer({ pockets }: { pockets: PocketMesh[] | null }) {
  const invalidate = useThree((s) => s.invalidate);
  const group = useMemo(() => {
    const g = new THREE.Group();
    for (const p of pockets ?? []) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(p.positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(p.normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(p.indices, 1));
      const depth = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true }));
      depth.renderOrder = 10;
      const color = new THREE.Color(p.color);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        color, emissive: color, emissiveIntensity: 0.5, roughness: 0.5, metalness: 0,
        transparent: true, opacity: OPACITY, depthWrite: false, depthFunc: THREE.LessEqualDepth,
      }));
      mesh.renderOrder = 11;
      for (const m of [depth, mesh]) { m.raycast = () => {}; g.add(m); }
    }
    return g;
  }, [pockets]);

  useEffect(() => {
    invalidate();
    return () => group.traverse((o) => {
      if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
    });
  }, [group, invalidate]);

  return <primitive object={group} />;
}
