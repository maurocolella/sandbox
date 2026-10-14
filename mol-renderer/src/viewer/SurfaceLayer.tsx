/*
 Title: SurfaceLayer
 Description: Renders a molecular surface from raw typed arrays, as a list of chunks that may grow while it
 streams in (appended chunks are added in place). Materials live for the component's lifetime (so shader
 programs are compiled once), a new surface is compiled asynchronously and swapped in only when ready (the
 previous one stays on screen meanwhile), and the wireframe is a visibility toggle over an edge index that
 shares the mesh's position buffer. Vertices can be coloured by electrostatic potential (red negative, white
 neutral, blue positive), and per-atom colours paint the vertices nearest each atom over that.
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
  /** Per vertex, the atom it belongs to (indexes `atomColors`). */
  atomIndex?: Uint32Array;
  /** Per vertex, electrostatic potential (kcal/(mol·e)). */
  potential?: Float32Array;
}

const BASE = new THREE.Color(0x77aaff);
// sRGB, blended in sRGB so mid-scale values stay visible
const NEGATIVE = new THREE.Color().setHex(0xd7301f, THREE.LinearSRGBColorSpace), NEUTRAL = new THREE.Color().setHex(0xffffff, THREE.LinearSRGBColorSpace),
  POSITIVE = new THREE.Color().setHex(0x2b6cd6, THREE.LinearSRGBColorSpace);

interface Built {
  group: THREE.Group;
  depth: THREE.Mesh;
  lines: THREE.LineSegments;
  geometries: THREE.BufferGeometry[];
  data: SurfaceData;
  color: THREE.BufferAttribute;
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

/**
 * Vertex colours: the atom's colour (linear RGB, 3 per atom) where it has one (r >= 0), else the potential
 * mapped over ±potentialRange when given, else the base colour.
 */
function paint(b: Built, atomColors: Float32Array | null, potentialRange: number | null) {
  const out = b.color.array as Float32Array, ai = b.data.atomIndex, phi = potentialRange ? b.data.potential : undefined;
  const c = new THREE.Color();
  for (let v = 0; v < out.length / 3; v++) {
    const a = ai && atomColors ? ai[v]! * 3 : -1;
    if (a >= 0 && atomColors![a]! >= 0) {
      out[v * 3] = atomColors![a]!; out[v * 3 + 1] = atomColors![a + 1]!; out[v * 3 + 2] = atomColors![a + 2]!;
      continue;
    }
    if (phi) {
      const t = Math.max(-1, Math.min(1, phi[v]! / potentialRange!));
      c.lerpColors(NEUTRAL, t < 0 ? NEGATIVE : POSITIVE, Math.abs(t));
      c.setRGB(c.r, c.g, c.b, THREE.SRGBColorSpace);
    } else c.copy(BASE);
    out[v * 3] = c.r; out[v * 3 + 1] = c.g; out[v * 3 + 2] = c.b;
  }
  b.color.needsUpdate = true;
}

function build(data: SurfaceData, mesh: THREE.Material, depthOnly: THREE.Material, line: THREE.Material): Built {
  const position = new THREE.BufferAttribute(data.positions, 3);
  const color = new THREE.BufferAttribute(new Float32Array(data.positions.length), 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", position);
  g.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
  g.setAttribute("color", color);
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
  return { group, depth, lines, geometries: [g, lg], data, color };
}

const disposeShown = (s: Shown | null) => s?.chunks.forEach((b) => b.geometries.forEach((g) => g.dispose()));

export interface SurfaceLayerProps {
  data: SurfaceData[] | null;
  wireframe: boolean;
  opacity?: number;
  /** Linear RGB per atom (r < 0: none), painted over everything else. */
  atomColors?: Float32Array | null;
  /** Colour by electrostatic potential, saturating at ± this (kcal/(mol·e)); null for the uniform colour. */
  potentialRange?: number | null;
}

export function SurfaceLayer({ data, wireframe, opacity = 1, atomColors = null, potentialRange = null }: SurfaceLayerProps) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);

  const materials = useMemo(() => {
    // Polygon offset keeps the wireframe from z-fighting; prepass and colour pass must share it to get equal depths
    const offset = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
    return {
      // A little sheen gives a silky rim without gloss. Always 'transparent' so toggling opacity never recompiles
      mesh: new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: 0, roughness: 0.6, sheen: 0.35, sheenRoughness: 0.5, sheenColor: 0xffffff, transparent: true, depthFunc: THREE.LessEqualDepth, ...offset }),
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
  const atomColorsRef = useRef(atomColors);
  atomColorsRef.current = atomColors;
  const potentialRangeRef = useRef(potentialRange);
  potentialRangeRef.current = potentialRange;
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
        paint(b, atomColorsRef.current, potentialRangeRef.current);
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
    next.group.userData.ptRole = "surface";
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

  useEffect(() => {
    for (const b of allChunks()) paint(b, atomColors, potentialRange);
    invalidate();
  }, [shown, atomColors, potentialRange, invalidate]);

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
