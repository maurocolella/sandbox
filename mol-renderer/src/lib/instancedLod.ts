/*
 Title: instancedLod
 Description: One InstancedMesh per instance set (atoms, bonds) with level-of-detail geometry.
 - Levels are geometries from finest to coarsest; a null level hides the set (0 triangles).
 - The level comes from the on-screen size of the largest feature at the set's nearest point, with
   hysteresis (refine above a threshold +15%, coarsen below it -15%) so sizes near a threshold don't
   flicker. Switching level only swaps the geometry reference.
*/
import * as THREE from "three";

export interface LodInstances {
  mesh: THREE.InstancedMesh;
  /** Geometries from finest to coarsest; null = hidden. */
  levels: (THREE.BufferGeometry | null)[];
  /** Minimum projected feature size (px) for each level but the last. */
  levelMinPx: number[];
  /** World-space size (e.g. atom or bond radius) whose projection selects the level. */
  featureSize: number;
  level: number;
  /** Camera state of the last evaluation, to skip unchanged frames. */
  lastView: Float64Array;
  dispose(): void;
}

export interface LodBuildInput {
  count: number;
  /** Writes instance i's 4x4 matrix (column-major) at `out[o..o+15]`; returns its feature size. */
  writeMatrix: (i: number, out: Float32Array, o: number) => number;
  /** Optional per-instance RGB 0..1 at `out[o..o+2]`. */
  writeColor?: (i: number, out: Float32Array, o: number) => void;
  levels: (THREE.BufferGeometry | null)[];
  levelMinPx: number[];
  material: THREE.Material;
}

export function buildLodInstances(input: LodBuildInput): LodInstances {
  const { count, writeMatrix, writeColor, levels, levelMinPx, material } = input;
  // Start at the coarsest drawable level; the first frame picks the real one
  const start = levels.reduce((last, g, i) => (g ? i : last), 0);
  const mesh = new THREE.InstancedMesh(levels[start]!, material, count);
  const m = mesh.instanceMatrix.array as Float32Array;
  const col = writeColor ? new Float32Array(count * 3) : null;
  let feature = 0;
  for (let i = 0; i < count; i++) {
    const f = writeMatrix(i, m, i * 16);
    if (f > feature) feature = f;
    if (col) writeColor!(i, col, i * 3);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (col) mesh.instanceColor = new THREE.InstancedBufferAttribute(col, 3);
  mesh.computeBoundingSphere();
  mesh.raycast = () => {}; // hover picking uses its own grid
  return {
    mesh, levels, levelMinPx, featureSize: feature, level: start,
    lastView: new Float64Array(33).fill(NaN),
    dispose() {
      mesh.dispose();
      for (const g of levels) g?.dispose();
      material.dispose();
    },
  };
}

const HYSTERESIS = 0.15;
const sphere = new THREE.Sphere();
const camPos = new THREE.Vector3();

/** True if camera and viewport are exactly as at the last evaluation (records the new state otherwise). */
function viewUnchanged(set: LodInstances, camera: THREE.Camera, viewportHeightPx: number): boolean {
  const v = set.lastView, w = camera.matrixWorld.elements, p = camera.projectionMatrix.elements;
  let same = v[32] === viewportHeightPx;
  for (let i = 0; i < 16; i++) { if (v[i] !== w[i] || v[16 + i] !== p[i]) same = false; v[i] = w[i]!; v[16 + i] = p[i]!; }
  v[32] = viewportHeightPx;
  return same;
}

/** Pick the set's level for the current camera; returns true if it changed. */
export function updateLod(set: LodInstances, camera: THREE.Camera, viewportHeightPx: number): boolean {
  if (viewUnchanged(set, camera, viewportHeightPx)) return false;
  const last = set.levels.length - 1;
  camPos.setFromMatrixPosition(camera.matrixWorld);
  const persp = camera as THREE.PerspectiveCamera, ortho = camera as THREE.OrthographicCamera;
  const focalPx = persp.isPerspectiveCamera
    ? viewportHeightPx / (2 * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2))
    : viewportHeightPx / ((ortho.top - ortho.bottom) / ortho.zoom);
  sphere.copy(set.mesh.boundingSphere!).applyMatrix4(set.mesh.matrixWorld);
  const dist = Math.max(1e-3, sphere.center.distanceTo(camPos) - sphere.radius); // nearest point of the set
  const px = persp.isPerspectiveCamera ? (set.featureSize * focalPx) / dist : set.featureSize * focalPx;
  let level = set.level;
  while (level > 0 && px >= set.levelMinPx[level - 1]! * (1 + HYSTERESIS)) level--;
  while (level < last && px < set.levelMinPx[level]! * (1 - HYSTERESIS)) level++;
  if (level === set.level) return false;
  set.level = level;
  const g = set.levels[level];
  set.mesh.visible = !!g;
  if (g) set.mesh.geometry = g;
  return true;
}
