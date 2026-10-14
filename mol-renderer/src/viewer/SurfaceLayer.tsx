/*
 Title: SurfaceLayer
 Description: Renders a molecular surface from raw typed arrays, as a list of chunks that may grow while it
 streams in (appended chunks are added in place). Materials live for the component's lifetime (so shader
 programs are compiled once), a new surface is compiled asynchronously and swapped in only when ready (the
 previous one stays on screen meanwhile), and the wireframe is a visibility toggle over an edge index that
 shares the mesh's position buffer.
 Transparency (PyMOL-style): a depth-only prepass of the surface, then the colour pass blended with
 depthFunc LessEqual, so only the front-most surface layer shows over what's behind it, free of the
 intra-mesh sorting artefacts a single transparent mesh would have. All surface passes sit in the
 transparent queue (prepass -> colour -> wireframe) so they draw after the opaque molecule.
*/
import { useEffect, useMemo, useRef, useState } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";

export interface SurfaceData {
  positions: Float32Array;
  normals: Float32Array;
  indices?: Uint32Array;
}

interface Built {
  group: THREE.Group;
  depth: THREE.Mesh;
  lines: THREE.LineSegments;
  geometries: THREE.BufferGeometry[];
}

/** One surface: its chunks so far. */
interface Shown {
  first: SurfaceData; // identifies the surface across appends
  group: THREE.Group;
  chunks: Built[];
}

/**
 * Unique edges of an indexed triangle mesh. On a closed, consistently wound mesh every edge appears once
 * in each direction, so keeping the a < b direction yields each edge exactly once without hashing.
 */
function edgeIndex(indices: Uint32Array): Uint32Array {
  const out = new Uint32Array(indices.length);
  let n = 0;
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e]!, b = indices[t + (e + 1) % 3]!;
      if (a < b) { out[n++] = a; out[n++] = b; }
    }
  }
  return out.slice(0, n);
}

function build(data: SurfaceData, mesh: THREE.Material, depthOnly: THREE.Material, line: THREE.Material): Built {
  const position = new THREE.BufferAttribute(data.positions, 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", position);
  g.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
  if (data.indices) g.setIndex(new THREE.BufferAttribute(data.indices, 1));
  g.computeBoundingSphere();

  const lg = new THREE.BufferGeometry();
  lg.setAttribute("position", position);
  if (data.indices) lg.setIndex(new THREE.BufferAttribute(edgeIndex(data.indices), 1));
  lg.boundingSphere = g.boundingSphere;

  const depth = new THREE.Mesh(g, depthOnly);
  depth.renderOrder = 1;
  const m = new THREE.Mesh(g, mesh);
  m.renderOrder = 2;
  const lines = new THREE.LineSegments(lg, line);
  lines.renderOrder = 3;
  const group = new THREE.Group();
  group.add(depth, m, lines);
  return { group, depth, lines, geometries: [g, lg] };
}

const disposeShown = (s: Shown | null) => s?.chunks.forEach((b) => b.geometries.forEach((g) => g.dispose()));

export function SurfaceLayer({ data, wireframe, opacity = 1 }: { data: SurfaceData[] | null; wireframe: boolean; opacity?: number }) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);

  const materials = useMemo(() => {
    // Polygon offset keeps the wireframe from z-fighting; prepass and colour pass must share it to get equal depths
    const offset = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
    return {
      // A little sheen gives a silky rim without gloss. Always 'transparent' so toggling opacity never recompiles
      mesh: new THREE.MeshPhysicalMaterial({ color: 0x77aaff, metalness: 0, roughness: 0.6, sheen: 0.35, sheenRoughness: 0.5, sheenColor: 0xffffff, transparent: true, depthFunc: THREE.LessEqualDepth, ...offset }),
      depth: new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true, depthWrite: true, ...offset }),
      line: new THREE.LineBasicMaterial({ color: 0x111111, depthWrite: false, transparent: true }),
    };
  }, []);
  useEffect(() => () => { materials.mesh.dispose(); materials.depth.dispose(); materials.line.dispose(); }, [materials]);

  const [shown, setShown] = useState<Shown | null>(null);
  const shownRef = useRef<Shown | null>(null);
  shownRef.current = shown;
  // The newest surface, shown or still compiling
  const latest = useRef<Shown | null>(null);
  const wireframeRef = useRef(wireframe);
  wireframeRef.current = wireframe;
  const opacityRef = useRef(opacity);
  opacityRef.current = opacity;
  const allChunks = () => [...new Set([shownRef.current, latest.current])].flatMap((s) => s?.chunks ?? []);

  useEffect(() => {
    const chunks = data?.filter((c) => c.positions.length > 0) ?? [];
    if (chunks.length === 0) {
      if (latest.current !== shownRef.current) disposeShown(latest.current);
      latest.current = null;
      disposeShown(shownRef.current);
      setShown(null);
      invalidate();
      return;
    }
    const add = (target: Shown, from: number) => {
      for (const c of chunks.slice(from)) {
        const b = build(c, materials.mesh, materials.depth, materials.line);
        b.lines.visible = wireframeRef.current;
        b.depth.visible = opacityRef.current < 1;
        target.group.add(b.group);
        target.chunks.push(b);
      }
    };
    // More chunks of the same surface: its programs are compiled already
    if (latest.current?.first === chunks[0]) {
      add(latest.current, latest.current.chunks.length);
      invalidate();
      return;
    }
    if (latest.current !== shownRef.current) disposeShown(latest.current);
    const next: Shown = { first: chunks[0]!, group: new THREE.Group(), chunks: [] };
    latest.current = next;
    add(next, 0);
    // Compile off the critical path (parallel where the driver supports it), then swap
    gl.compileAsync(next.group, camera, scene)
      .catch(() => undefined)
      .then(() => {
        if (latest.current !== next) return;
        const previous = shownRef.current;
        setShown(next);
        // Free the old buffers only after the new surface has been committed
        requestAnimationFrame(() => disposeShown(previous));
        invalidate();
      });
  }, [data, gl, camera, scene, materials, invalidate]);

  useEffect(() => {
    for (const b of allChunks()) b.lines.visible = wireframe;
    invalidate();
  }, [shown, wireframe, invalidate]);

  // Opaque: single pass writing depth. Translucent: depth prepass + blended front-layer colour pass
  useEffect(() => {
    const translucent = opacity < 1;
    materials.mesh.opacity = Math.max(0, Math.min(1, opacity));
    materials.mesh.depthWrite = !translucent;
    for (const b of allChunks()) b.depth.visible = translucent;
    invalidate();
  }, [shown, opacity, materials, invalidate]);

  useEffect(() => () => {
    if (latest.current !== shownRef.current) disposeShown(latest.current);
    disposeShown(shownRef.current);
  }, []);

  return shown ? <primitive object={shown.group} /> : null;
}
