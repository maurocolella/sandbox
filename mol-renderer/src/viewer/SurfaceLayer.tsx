/*
 Title: SurfaceLayer
 Description: Renders a molecular surface from raw typed arrays. Materials live for the component's lifetime
 (so shader programs are compiled once), a new surface is compiled asynchronously and swapped in only when
 ready (the previous one stays on screen meanwhile), and the wireframe is a visibility toggle over an edge
 index that shares the mesh's position buffer.
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
  lines: THREE.LineSegments;
  geometries: THREE.BufferGeometry[];
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

function build(data: SurfaceData, mesh: THREE.Material, line: THREE.Material): Built {
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

  const m = new THREE.Mesh(g, mesh);
  m.renderOrder = 1;
  const lines = new THREE.LineSegments(lg, line);
  lines.renderOrder = 2;
  const group = new THREE.Group();
  group.add(m, lines);
  return { group, lines, geometries: [g, lg] };
}

const disposeBuilt = (b: Built | null) => b?.geometries.forEach((g) => g.dispose());

export function SurfaceLayer({ data, wireframe }: { data: SurfaceData | null; wireframe: boolean }) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);

  const materials = useMemo(() => ({
    // Offset the fill back so the wireframe drawn over it doesn't z-fight
    mesh: new THREE.MeshStandardMaterial({ color: 0x77aaff, metalness: 0, roughness: 1, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
    line: new THREE.LineBasicMaterial({ color: 0x111111, depthWrite: false }),
  }), []);
  useEffect(() => () => { materials.mesh.dispose(); materials.line.dispose(); }, [materials]);

  const [shown, setShown] = useState<Built | null>(null);
  const shownRef = useRef<Built | null>(null);
  shownRef.current = shown;
  const wireframeRef = useRef(wireframe);
  wireframeRef.current = wireframe;

  useEffect(() => {
    if (!data || data.positions.length === 0) {
      disposeBuilt(shownRef.current);
      setShown(null);
      invalidate();
      return;
    }
    let current = true;
    const next = build(data, materials.mesh, materials.line);
    next.lines.visible = wireframeRef.current;
    // Compile off the critical path (parallel where the driver supports it), then swap
    gl.compileAsync(next.group, camera, scene)
      .catch(() => undefined)
      .then(() => {
        if (!current) { disposeBuilt(next); return; }
        const previous = shownRef.current;
        setShown(next);
        // Free the old buffers only after the new surface has been committed
        requestAnimationFrame(() => disposeBuilt(previous));
        invalidate();
      });
    return () => { current = false; };
  }, [data, gl, camera, scene, materials, invalidate]);

  useEffect(() => {
    if (shown) { shown.lines.visible = wireframe; invalidate(); }
  }, [shown, wireframe, invalidate]);

  useEffect(() => () => disposeBuilt(shownRef.current), []);

  return shown ? <primitive object={shown.group} /> : null;
}
