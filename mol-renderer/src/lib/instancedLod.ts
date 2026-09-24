/*
 Title: instancedLod
 Description: Per-instance level of detail for instance sets (atoms, bonds), with hierarchical frustum culling.
 - Each instance's transform (rows of its 3x4 matrix) and color live in GPU textures, uploaded once. There is
   one mesh per level (at most one draw call per level); each draws a list of instance indices, and its
   vertex shader fetches the instance's transform from the texture.
 - Each instance picks its level from its own on-screen size: its feature (atom or bond radius) projected at
   its nearest point, with hysteresis (refine above a threshold +15%, coarsen below it -15%) so sizes near a
   threshold don't flicker. A null level hides the instance.
 - A bounding-sphere hierarchy (k-d split, midpoint of the longest axis) over the instances skips nodes
   outside the view, and gives a whole node one level when all of its instances would get it anyway, so
   only leaves straddling a threshold are visited instance by instance.
 - The index lists are rebuilt when the view changes, and only the part that differs from the last upload
   is sent to the GPU.
*/
import * as THREE from "three";

const TEX_WIDTH = 4096;
const LEAF_SIZE = 32;
const HYSTERESIS = 0.15;
const UNSET = 255;

export interface LodInstances {
  group: THREE.Group;
  count: number;
  /** One mesh per level (null where the level hides instances). */
  meshes: (THREE.Mesh | null)[];
  levelMinPx: number[];
  /** Instance centers (xyz), bounding radii and feature sizes, by instance index. */
  centers: Float32Array;
  extents: Float32Array;
  features: Float32Array;
  /** Level of each instance (hysteresis state); UNSET before its first evaluation. */
  state: Uint8Array;
  /** Instance indices, grouped so each hierarchy node covers a contiguous range. */
  order: Uint32Array;
  /** Hierarchy nodes: instance range, children (-1 for leaves), bounding sphere, feature range. */
  nodeStart: Uint32Array;
  nodeEnd: Uint32Array;
  nodeLeft: Int32Array;
  nodeRight: Int32Array;
  nodeSphere: Float32Array; // x, y, z, r
  nodeFeature: Float32Array; // min, max
  /** Per-level index lists and how many entries are drawn. */
  lists: (Uint32Array | null)[];
  listCounts: Uint32Array;
  /** Camera state of the last evaluation, to skip unchanged frames. */
  lastView: Float64Array;
  dispose(): void;
}

export interface LodBuildInput {
  count: number;
  /** Writes instance i's 4x4 matrix (column-major) at `out[o..o+15]`; returns its feature size. */
  writeMatrix: (i: number, out: Float32Array, o: number) => number;
  /** Radius around the instance's translation that bounds it. */
  extentOf: (i: number) => number;
  /** Optional per-instance RGB 0..1 at `out[o..o+2]`. */
  writeColor?: (i: number, out: Float32Array, o: number) => void;
  levels: (THREE.BufferGeometry | null)[];
  levelMinPx: number[];
  material: THREE.Material;
}

/** Makes `material` read each instance's transform and color from textures, indexed by the `aInst` attribute. */
function readInstancesFromTextures(material: THREE.Material, matrices: THREE.DataTexture, colors: THREE.DataTexture) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uInstMatrix = { value: matrices };
    shader.uniforms.uInstColor = { value: colors };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
uniform highp sampler2D uInstMatrix;
uniform highp sampler2D uInstColor;
attribute uint aInst;
varying vec3 vInstColor;
ivec2 lodTexel(uint t) { return ivec2(int(t % ${TEX_WIDTH}u), int(t / ${TEX_WIDTH}u)); }`)
      .replace("#include <beginnormal_vertex>", `#include <beginnormal_vertex>
uint lodT = aInst * 3u;
mat4 lodM = transpose(mat4(
  texelFetch(uInstMatrix, lodTexel(lodT), 0),
  texelFetch(uInstMatrix, lodTexel(lodT + 1u), 0),
  texelFetch(uInstMatrix, lodTexel(lodT + 2u), 0),
  vec4(0.0, 0.0, 0.0, 1.0)));
{
  mat3 im = mat3(lodM);
  objectNormal /= vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2]));
  objectNormal = im * objectNormal;
}
vInstColor = texelFetch(uInstColor, lodTexel(aInst), 0).rgb;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
transformed = (lodM * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vInstColor;")
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb *= vInstColor;");
  };
}

export function buildLodInstances(input: LodBuildInput): LodInstances {
  const { count, writeMatrix, extentOf, writeColor, levels, levelMinPx, material } = input;

  // Instance data: transform rows and colors for the GPU; centers, extents and features for level selection
  const rows = Math.max(1, Math.ceil((count * 3) / TEX_WIDTH));
  const matData = new Float32Array(TEX_WIDTH * rows * 4);
  const colorRows = Math.max(1, Math.ceil(count / TEX_WIDTH));
  const colorData = new Uint8Array(TEX_WIDTH * colorRows * 4).fill(255);
  const centers = new Float32Array(count * 3), extents = new Float32Array(count), features = new Float32Array(count);
  const m = new Float32Array(16), c = new Float32Array(3);
  for (let i = 0; i < count; i++) {
    features[i] = writeMatrix(i, m, 0);
    for (let r = 0; r < 3; r++) {
      const o = (i * 3 + r) * 4;
      matData[o] = m[r]!; matData[o + 1] = m[4 + r]!; matData[o + 2] = m[8 + r]!; matData[o + 3] = m[12 + r]!;
    }
    centers[i * 3] = m[12]!; centers[i * 3 + 1] = m[13]!; centers[i * 3 + 2] = m[14]!;
    extents[i] = extentOf(i);
    if (writeColor) {
      writeColor(i, c, 0);
      colorData[i * 4] = Math.round(c[0]! * 255); colorData[i * 4 + 1] = Math.round(c[1]! * 255); colorData[i * 4 + 2] = Math.round(c[2]! * 255);
    }
  }
  const matrices = new THREE.DataTexture(matData, TEX_WIDTH, rows, THREE.RGBAFormat, THREE.FloatType);
  const colors = new THREE.DataTexture(colorData, TEX_WIDTH, colorRows, THREE.RGBAFormat, THREE.UnsignedByteType);
  matrices.needsUpdate = true;
  colors.needsUpdate = true;
  readInstancesFromTextures(material, matrices, colors);

  // Bounding-sphere hierarchy
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  const nStart: number[] = [], nEnd: number[] = [], nLeft: number[] = [], nRight: number[] = [];
  const nSphere: number[] = [], nFeature: number[] = [];
  const build = (start: number, end: number, depth: number): number => {
    const id = nStart.length;
    nStart.push(start); nEnd.push(end); nLeft.push(-1); nRight.push(-1);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let fMin = Infinity, fMax = 0;
    for (let k = start; k < end; k++) {
      const i = order[k]!;
      for (let a = 0; a < 3; a++) { const v = centers[i * 3 + a]!; if (v < min[a]!) min[a] = v; if (v > max[a]!) max[a] = v; }
      const f = features[i]!; if (f < fMin) fMin = f; if (f > fMax) fMax = f;
    }
    const cx = (min[0]! + max[0]!) / 2, cy = (min[1]! + max[1]!) / 2, cz = (min[2]! + max[2]!) / 2;
    let radius = 0;
    for (let k = start; k < end; k++) {
      const i = order[k]!;
      const dx = centers[i * 3]! - cx, dy = centers[i * 3 + 1]! - cy, dz = centers[i * 3 + 2]! - cz;
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz) + extents[i]!;
      if (r > radius) radius = r;
    }
    nSphere.push(cx, cy, cz, radius);
    nFeature.push(fMin, fMax);
    if (end - start <= LEAF_SIZE || depth > 40) return id;
    const axis = [0, 1, 2].reduce((best, a) => (max[a]! - min[a]! > max[best]! - min[best]! ? a : best), 0);
    const mid = (min[axis]! + max[axis]!) / 2;
    let lo = start, hi = end - 1;
    while (lo <= hi) {
      if (centers[order[lo]! * 3 + axis]! < mid) lo++;
      else { const t = order[lo]!; order[lo] = order[hi]!; order[hi] = t; hi--; }
    }
    if (lo === start || lo === end) return id; // all coincident: keep as a leaf
    nLeft[id] = build(start, lo, depth + 1);
    nRight[id] = build(lo, end, depth + 1);
    return id;
  };
  if (count > 0) build(0, count, 0);

  // One mesh per drawable level, drawing the instances listed in its `aInst` attribute
  const group = new THREE.Group();
  const lists: (Uint32Array | null)[] = [];
  const meshes = levels.map((base) => {
    if (!base) { lists.push(null); return null; }
    const g = new THREE.InstancedBufferGeometry();
    for (const [name, attr] of Object.entries(base.attributes)) g.setAttribute(name, attr);
    if (base.index) g.setIndex(base.index);
    const list = new Uint32Array(Math.max(1, count));
    lists.push(list);
    g.setAttribute("aInst", new THREE.InstancedBufferAttribute(list, 1).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = 0;
    const mesh = new THREE.Mesh(g, material);
    mesh.frustumCulled = false; // culled per node here
    mesh.visible = false;
    mesh.raycast = () => {}; // hover picking uses its own grid
    group.add(mesh);
    return mesh;
  });

  return {
    group, count, meshes, levelMinPx, centers, extents, features,
    state: new Uint8Array(count).fill(UNSET),
    order,
    nodeStart: Uint32Array.from(nStart), nodeEnd: Uint32Array.from(nEnd),
    nodeLeft: Int32Array.from(nLeft), nodeRight: Int32Array.from(nRight),
    nodeSphere: Float32Array.from(nSphere), nodeFeature: Float32Array.from(nFeature),
    lists, listCounts: new Uint32Array(levels.length),
    lastView: new Float64Array(33).fill(NaN),
    dispose() {
      for (const mesh of meshes) mesh?.geometry.dispose();
      for (const g of levels) g?.dispose();
      matrices.dispose();
      colors.dispose();
      material.dispose();
    },
  };
}

const frustum = new THREE.Frustum();
const projLocal = new THREE.Matrix4();
const invWorld = new THREE.Matrix4();
const sphere = new THREE.Sphere();
const cam = new THREE.Vector3();
// Reused per call (no per-frame allocation)
let stack = new Int32Array(256);
let cursor = new Uint32Array(8); // per-level write position
let firstDiff = new Uint32Array(8); // per-level first entry that differs from the last upload

/** True if camera and viewport are exactly as at the last evaluation (records the new state otherwise). */
function viewUnchanged(set: LodInstances, camera: THREE.Camera, viewportHeightPx: number): boolean {
  const v = set.lastView, w = camera.matrixWorld.elements, p = camera.projectionMatrix.elements;
  let same = v[32] === viewportHeightPx;
  for (let i = 0; i < 16; i++) { if (v[i] !== w[i] || v[16 + i] !== p[i]) same = false; v[i] = w[i]!; v[16 + i] = p[i]!; }
  v[32] = viewportHeightPx;
  return same;
}

/** Rebuild the per-level instance lists for the current camera; returns true if anything drawn changed. */
export function updateLod(set: LodInstances, camera: THREE.Camera, viewportHeightPx: number): boolean {
  if (viewUnchanged(set, camera, viewportHeightPx)) return false;
  const nLevels = set.meshes.length, last = nLevels - 1, minPx = set.levelMinPx;
  const { centers, extents, features, state, order, lists, nodeStart, nodeEnd, nodeLeft, nodeRight, nodeSphere, nodeFeature } = set;
  if (cursor.length < nLevels) { cursor = new Uint32Array(nLevels); firstDiff = new Uint32Array(nLevels); }
  for (let l = 0; l < nLevels; l++) { cursor[l] = 0; firstDiff[l] = 0xffffffff; }

  // Work in the set's local space
  invWorld.copy(set.group.matrixWorld).invert();
  cam.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(invWorld);
  projLocal.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(set.group.matrixWorld);
  frustum.setFromProjectionMatrix(projLocal);
  const persp = camera as THREE.PerspectiveCamera, ortho = camera as THREE.OrthographicCamera;
  const isPersp = !!persp.isPerspectiveCamera;
  const focalPx = isPersp
    ? viewportHeightPx / (2 * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2))
    : viewportHeightPx / ((ortho.top - ortho.bottom) / ortho.zoom);
  const cx = cam.x, cy = cam.y, cz = cam.z;

  const push = (level: number, index: number) => {
    const list = lists[level];
    if (!list) return; // hidden level
    const k = cursor[level]!;
    if (list[k] !== index) { if (k < firstDiff[level]!) firstDiff[level] = k; list[k] = index; }
    cursor[level] = k + 1;
  };

  let top = 0;
  if (set.count > 0) stack[top++] = 0;
  while (top > 0) {
    const n = stack[--top]!;
    const sx = nodeSphere[n * 4]!, sy = nodeSphere[n * 4 + 1]!, sz = nodeSphere[n * 4 + 2]!, sr = nodeSphere[n * 4 + 3]!;
    sphere.center.set(sx, sy, sz); sphere.radius = sr;
    if (!frustum.intersectsSphere(sphere)) continue;
    const start = nodeStart[n]!, end = nodeEnd[n]!;
    // Projected feature range over the node: largest feature at its nearest point, smallest at its farthest
    const dx = sx - cx, dy = sy - cy, dz = sz - cz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const pxHi = isPersp ? (nodeFeature[n * 2 + 1]! * focalPx) / Math.max(1e-3, d - sr) : nodeFeature[n * 2 + 1]! * focalPx;
    const pxLo = isPersp ? (nodeFeature[n * 2]! * focalPx) / (d + sr) : nodeFeature[n * 2]! * focalPx;
    // If the whole range sits clear of the thresholds (hysteresis included), every instance gets the same level
    let level = 0;
    while (level < last && pxHi < minPx[level]! * (1 - HYSTERESIS)) level++;
    if (level === last || pxLo >= minPx[level]! * (1 + HYSTERESIS)) {
      for (let k = start; k < end; k++) { const i = order[k]!; state[i] = level; push(level, i); }
      continue;
    }
    const left = nodeLeft[n]!;
    if (left >= 0) {
      if (top + 2 > stack.length) { const s = new Int32Array(stack.length * 2); s.set(stack); stack = s; }
      stack[top++] = nodeRight[n]!;
      stack[top++] = left;
      continue;
    }
    // Leaf straddling a threshold: each instance on its own, with hysteresis
    for (let k = start; k < end; k++) {
      const i = order[k]!;
      const ex = centers[i * 3]! - cx, ey = centers[i * 3 + 1]! - cy, ez = centers[i * 3 + 2]! - cz;
      const di = Math.max(1e-3, Math.sqrt(ex * ex + ey * ey + ez * ez) - extents[i]!);
      const px = isPersp ? (features[i]! * focalPx) / di : features[i]! * focalPx;
      let l = state[i] === UNSET ? last : state[i]!;
      while (l > 0 && px >= minPx[l - 1]! * (1 + HYSTERESIS)) l--;
      while (l < last && px < minPx[l]! * (1 - HYSTERESIS)) l++;
      state[i] = l;
      push(l, i);
    }
  }

  let changed = false;
  for (let l = 0; l < nLevels; l++) {
    const mesh = set.meshes[l];
    if (!mesh) continue;
    const n = cursor[l]!, geom = mesh.geometry as THREE.InstancedBufferGeometry;
    if (firstDiff[l]! < n) {
      const attr = geom.getAttribute("aInst") as THREE.InstancedBufferAttribute;
      attr.addUpdateRange(firstDiff[l]!, n - firstDiff[l]!);
      attr.needsUpdate = true;
      changed = true;
    }
    if (set.listCounts[l] !== n) { set.listCounts[l] = n; changed = true; }
    geom.instanceCount = n;
    mesh.visible = n > 0;
  }
  return changed;
}
