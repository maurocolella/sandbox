/*
 Title: chunked
 Description: Spatially chunked instanced meshes with per-chunk level of detail, shared by atoms and bonds.
 - Instances are split by a k-d split (longest axis, midpoint) down to ~CHUNK_SIZE per chunk. Each chunk is
   an InstancedMesh whose bounding sphere comes from its actual instances, so frustum culling is
   conservative: a chunk is skipped only when all of its instances are outside the view.
 - Levels are geometries from finest to coarsest; a null level hides the chunk (0 triangles). Each chunk
   gets its own geometry object per level, all sharing the same vertex buffers: Three.js caches vertex
   array bindings per geometry, so sharing one geometry across chunks (each with its own instance buffer)
   would force a full attribute re-setup on every draw, every frame.
   A chunk's level comes from the on-screen size of its largest feature at the chunk's nearest point, with
   hysteresis (refine above a threshold +15%, coarsen below it -15%) so sizes near a threshold don't
   flicker. Levels switch purely on what the view needs, never on camera motion. A triangle budget then
   coarsens the farthest visible chunks first, but never more than one level below what the chunk's
   on-screen size calls for (so near chunks never show facets); the budget is therefore soft. Switching
   level only swaps the geometry reference, so it can change every frame for free.
*/
import * as THREE from "three";

export const CHUNK_SIZE = 16384;

export interface Chunk {
  mesh: THREE.InstancedMesh;
  /** This chunk's geometry per level (sharing the set's vertex buffers); null = hidden. */
  geoms: (THREE.BufferGeometry | null)[];
  center: THREE.Vector3;
  radius: number;
  /** World-space size (e.g. atom or bond radius) whose projection selects the level. */
  featureSize: number;
  /** Level the view calls for (hysteresis state), before the budget. */
  ideal: number;
  /** Level currently drawn (ideal, possibly coarsened one step by the budget). */
  level: number;
}

export interface ChunkedInstances {
  group: THREE.Group;
  chunks: Chunk[];
  /** Geometries from finest to coarsest; null = hidden. */
  levels: (THREE.BufferGeometry | null)[];
  levelTriangles: number[];
  /** Minimum projected feature size (px) for each level but the last. */
  levelMinPx: number[];
  material: THREE.Material;
  /** Camera and budget state of the last evaluation, to skip unchanged frames. */
  lastView: Float64Array;
  dispose(): void;
}

/** A geometry object of its own that shares `base`'s buffers (no data copied). */
function shareGeometry(base: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(base.attributes)) g.setAttribute(name, attr);
  if (base.index) g.setIndex(base.index);
  if (!base.boundingSphere) base.computeBoundingSphere();
  g.boundingSphere = base.boundingSphere;
  return g;
}

export interface ChunkBuildInput {
  count: number;
  /** Position used to split instances into chunks (e.g. atom center, bond midpoint). */
  point: (i: number, axis: 0 | 1 | 2) => number;
  /** Writes instance i's 4x4 matrix (column-major) at `out[o..o+15]`; returns its feature size. */
  writeMatrix: (i: number, out: Float32Array, o: number) => number;
  /** Optional per-instance RGB 0..1 at `out[o..o+2]`. */
  writeColor?: (i: number, out: Float32Array, o: number) => void;
  levels: (THREE.BufferGeometry | null)[];
  levelMinPx: number[];
  material: THREE.Material;
}

export function buildChunked(input: ChunkBuildInput): ChunkedInstances {
  const { count, point, writeMatrix, writeColor, levels, levelMinPx, material } = input;
  const group = new THREE.Group();
  const chunks: Chunk[] = [];
  const levelTriangles = levels.map((g) => (!g ? 0 : g.index ? g.index.count / 3 : g.attributes.position!.count / 3));

  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  const leaves: [number, number][] = [];
  const split = (start: number, end: number, depth: number) => {
    const n = end - start;
    if (n <= CHUNK_SIZE || depth > 40) { if (n > 0) leaves.push([start, end]); return; }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let k = start; k < end; k++) {
      const i = order[k]!;
      for (let a = 0 as 0 | 1 | 2; a < 3; a++) { const v = point(i, a); if (v < min[a]!) min[a] = v; if (v > max[a]!) max[a] = v; }
    }
    const axis = ([0, 1, 2] as const).reduce((best, a) => (max[a]! - min[a]! > max[best]! - min[best]! ? a : best), 0 as 0 | 1 | 2);
    const mid = (min[axis]! + max[axis]!) / 2;
    let lo = start, hi = end - 1;
    while (lo <= hi) {
      if (point(order[lo]!, axis) < mid) lo++;
      else { const t = order[lo]!; order[lo] = order[hi]!; order[hi] = t; hi--; }
    }
    if (lo === start || lo === end) { leaves.push([start, end]); return; } // all coincident: keep as one
    split(start, lo, depth + 1);
    split(lo, end, depth + 1);
  };
  split(0, count, 0);

  // Start at the coarsest drawable level; the first frame picks real levels
  const coarsestDrawable = levels.reduce((last, g, i) => (g ? i : last), 0);
  for (const [start, end] of leaves) {
    const n = end - start;
    const geoms = levels.map((g) => (g ? shareGeometry(g) : null));
    const mesh = new THREE.InstancedMesh(geoms[coarsestDrawable]!, material, n);
    const m = mesh.instanceMatrix.array as Float32Array;
    const col = writeColor ? new Float32Array(n * 3) : null;
    let feature = 0;
    for (let k = 0; k < n; k++) {
      const i = order[start + k]!;
      const f = writeMatrix(i, m, k * 16);
      if (f > feature) feature = f;
      if (col) writeColor!(i, col, k * 3);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (col) mesh.instanceColor = new THREE.InstancedBufferAttribute(col, 3);
    // Bounds from the instances themselves: culling can only keep too much, never too little
    mesh.computeBoundingSphere();
    mesh.raycast = () => {}; // hover picking uses its own grid
    group.add(mesh);
    chunks.push({ mesh, geoms, center: mesh.boundingSphere!.center.clone(), radius: mesh.boundingSphere!.radius, featureSize: feature, ideal: coarsestDrawable, level: coarsestDrawable });
  }

  return {
    group, chunks, levels, levelTriangles, levelMinPx, material,
    lastView: new Float64Array(34).fill(NaN),
    dispose() {
      for (const c of chunks) { c.mesh.dispose(); for (const g of c.geoms) g?.dispose(); }
      for (const g of levels) g?.dispose();
      material.dispose();
    },
  };
}

const frustum = new THREE.Frustum();
const projScreen = new THREE.Matrix4();
const sphere = new THREE.Sphere();
const camPos = new THREE.Vector3();

const HYSTERESIS = 0.15;
// Reused per call (no per-frame allocation, so no garbage-collection spikes)
const visible: { chunk: Chunk; dist: number; level: number; maxLevel: number }[] = [];
const pool: { chunk: Chunk; dist: number; level: number; maxLevel: number }[] = [];

/** True if camera, viewport and budget are exactly as at the last evaluation (records the new state otherwise). */
function viewUnchanged(set: ChunkedInstances, camera: THREE.Camera, viewportHeightPx: number, triangleBudget: number): boolean {
  const v = set.lastView, w = camera.matrixWorld.elements, p = camera.projectionMatrix.elements;
  let same = v[32] === viewportHeightPx && v[33] === triangleBudget;
  for (let i = 0; i < 16; i++) { if (v[i] !== w[i] || v[16 + i] !== p[i]) same = false; v[i] = w[i]!; v[16 + i] = p[i]!; }
  v[32] = viewportHeightPx; v[33] = triangleBudget;
  return same;
}

/** Pick each chunk's level for the current camera; returns true if any level changed. */
export function updateLevels(set: ChunkedInstances, camera: THREE.Camera, viewportHeightPx: number, triangleBudget: number): boolean {
  if (viewUnchanged(set, camera, viewportHeightPx, triangleBudget)) return false;
  const last = set.levels.length - 1;
  camPos.setFromMatrixPosition(camera.matrixWorld);
  projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projScreen);
  const persp = camera as THREE.PerspectiveCamera, ortho = camera as THREE.OrthographicCamera;
  const focalPx = persp.isPerspectiveCamera
    ? viewportHeightPx / (2 * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2))
    : viewportHeightPx / ((ortho.top - ortho.bottom) / ortho.zoom);

  visible.length = 0;
  let total = 0;
  for (const chunk of set.chunks) {
    sphere.set(chunk.center, chunk.radius).applyMatrix4(chunk.mesh.matrixWorld);
    if (!frustum.intersectsSphere(sphere)) continue; // Three.js culls it; it costs nothing
    const dist = Math.max(1e-3, sphere.center.distanceTo(camPos) - sphere.radius); // nearest point of the chunk
    const px = persp.isPerspectiveCamera ? (chunk.featureSize * focalPx) / dist : chunk.featureSize * focalPx;
    // Hysteresis on the ideal level (not the drawn one, or the budget would fight it every frame):
    // refine only well above a threshold, coarsen only well below
    let level = Math.min(chunk.ideal, last);
    while (level > 0 && px >= set.levelMinPx[level - 1]! * (1 + HYSTERESIS)) level--;
    while (level < last && px < set.levelMinPx[level]! * (1 - HYSTERESIS)) level++;
    chunk.ideal = level;
    // The budget may coarsen by at most one level: beyond that, facets or gaps would show
    const entry = pool[visible.length] ?? (pool[visible.length] = { chunk, dist, level, maxLevel: 0 });
    entry.chunk = chunk; entry.dist = dist; entry.level = level; entry.maxLevel = Math.min(last, level + 1);
    visible.push(entry);
    total += chunk.mesh.count * set.levelTriangles[level]!;
  }
  if (total > triangleBudget) {
    visible.sort((a, b) => b.dist - a.dist); // farthest first
    let changed = true;
    while (total > triangleBudget && changed) {
      changed = false;
      for (const v of visible) {
        if (total <= triangleBudget) break;
        if (v.level >= v.maxLevel) continue;
        total -= v.chunk.mesh.count * (set.levelTriangles[v.level]! - set.levelTriangles[v.level + 1]!);
        v.level++;
        changed = true;
      }
    }
  }
  let anyChange = false;
  for (const v of visible) {
    if (v.chunk.level === v.level) continue;
    v.chunk.level = v.level;
    const g = v.chunk.geoms[v.level];
    v.chunk.mesh.visible = !!g;
    if (g) v.chunk.mesh.geometry = g;
    anyChange = true;
  }
  return anyChange;
}
