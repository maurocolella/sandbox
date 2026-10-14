/*
 Title: PocketLayer
 Description: Pocket surfaces (around the residues lining each pocket), glossy and slightly translucent,
 one colour each. Like SurfaceLayer, each draws a depth-only
 prepass, then its colour with depthFunc LessEqual, so only its front-most layer shows (no sorting artefacts
 within a mesh); both sit in the transparent queue, after the opaque molecule.
*/
import { useEffect, useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";

export interface PocketMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  color: THREE.ColorRepresentation;
}

const OPACITY = 0.7;

function build(p: PocketMesh): THREE.Mesh[] {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(p.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(p.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(p.indices, 1));
  const depth = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true }));
  depth.renderOrder = 10;
  // Plastic: smooth base with a clear coat for crisp highlights
  const mesh = new THREE.Mesh(geometry, new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(p.color), roughness: 0.35, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08,
    transparent: true, opacity: OPACITY, depthWrite: false, depthFunc: THREE.LessEqualDepth,
  }));
  mesh.renderOrder = 11;
  for (const m of [depth, mesh]) m.raycast = () => {};
  return [depth, mesh];
}

const dispose = (ms: THREE.Mesh[]) => {
  ms[0]!.geometry.dispose();
  for (const m of ms) (m.material as THREE.Material).dispose();
};

/** Pockets may stream in: only pockets not drawn yet are built. */
export function PocketLayer({ pockets }: { pockets: PocketMesh[] | null }) {
  const invalidate = useThree((s) => s.invalidate);
  const group = useMemo(() => Object.assign(new THREE.Group(), { userData: { ptRole: "pocket" } }), []);
  const built = useRef(new Map<PocketMesh, THREE.Mesh[]>());

  useEffect(() => {
    const keep = new Set(pockets ?? []);
    for (const [p, ms] of built.current) if (!keep.has(p)) { group.remove(...ms); dispose(ms); built.current.delete(p); }
    for (const p of keep) if (!built.current.has(p)) { const ms = build(p); group.add(...ms); built.current.set(p, ms); }
    invalidate();
  }, [pockets, group, invalidate]);

  useEffect(() => () => { for (const ms of built.current.values()) dispose(ms); built.current.clear(); }, []);

  return <primitive object={group} />;
}
