/*
 Title: instancedLod
 Description: Level of detail for instance sets (atoms, bonds), per leaf of a hierarchy, with hierarchical
 frustum culling.
 - A bounding-sphere hierarchy (k-d split of the longest axis at a multiple of LEAF_SIZE near the median)
   groups instances into leaves of exactly LEAF_SIZE (only the very last is shorter). Instance data is
   stored in hierarchy order, so leaf j holds instances j * LEAF_SIZE onwards.
 - Each instance's transform (rows of its 3x4 matrix) and color live in GPU textures, uploaded once. There is
   one mesh per level (at most one draw call per level); each draws a list of leaf ids, LEAF_SIZE instances
   per entry, and its vertex shader fetches each instance's transform from the texture.
 - Each leaf picks its level from its on-screen size: its largest feature (atom or bond radius) projected at
   its nearest point, with hysteresis (refine above a threshold +15%, coarsen below it -15%) so sizes near a
   threshold don't flicker. A null level hides the leaf; an impostor level draws one camera-facing
   triangle per instance, shaded as a sphere (for sub-pixel sizes).
 - The hierarchy skips nodes outside the view, and gives a whole node one level when all of its leaves
   would get it anyway. Nearer nodes are visited first, so each level draws roughly front to back.
 - The lists are rebuilt when the view changes (a leaf id per LEAF_SIZE instances keeps this cheap), and
   only the part that differs from the last upload is sent to the GPU.
 - `raycastSpheres` picks the nearest sphere instance along a ray through the same hierarchy.
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
  /** Level of each leaf (hysteresis state); UNSET before its first evaluation. */
  state: Uint8Array;
  /** Transform rows in hierarchy order (the matrix texture's data), and the instance index of each slot. */
  matData: Float32Array;
  order: Uint32Array;
  /** Hierarchy nodes: instance range (in hierarchy order), children (-1 for leaves), bounding sphere, feature range. */
  nodeStart: Uint32Array;
  nodeEnd: Uint32Array;
  nodeLeft: Int32Array;
  nodeRight: Int32Array;
  nodeSphere: Float32Array; // x, y, z, r
  nodeFeature: Float32Array; // min, max
  /** Per-level lists of leaf ids and how many entries are drawn. */
  lists: (Uint32Array | null)[];
  listCounts: Uint32Array;
  /** Camera state of the last evaluation, to skip unchanged frames. */
  lastView: Float64Array;
  dispose(): void;
}

export interface LodDataInput {
  count: number;
  /** Writes instance i's 4x4 matrix (column-major) at `out[o..o+15]`; returns its feature size. */
  writeMatrix: (i: number, out: Float32Array, o: number) => number;
  /** Radius around the instance's translation that bounds it. */
  extentOf: (i: number) => number;
  /** Optional per-instance RGB 0..1 at `out[o..o+2]`. */
  writeColor?: (i: number, out: Float32Array, o: number) => void;
}

/** Build progress: instance data written, then instances placed in the hierarchy's leaves. */
export interface LodBuildProgress {
  stage: "instances" | "tree";
  done: number;
  total: number;
}

/** Everything an instance set needs apart from GPU objects: plain typed arrays, so it can be built in a worker. */
export interface LodData {
  count: number;
  /** Transform rows (3 RGBA texels per instance) and colors (1 RGBA8 texel per instance), TEX_WIDTH wide, in hierarchy order. */
  matData: Float32Array;
  colorData: Uint8Array;
  /** Instance index of each slot in hierarchy order. */
  order: Uint32Array;
  nodeStart: Uint32Array;
  nodeEnd: Uint32Array;
  nodeLeft: Int32Array;
  nodeRight: Int32Array;
  nodeSphere: Float32Array;
  nodeFeature: Float32Array;
}

/** The buffers behind a LodData (for zero-copy transfer from a worker). */
export function lodDataTransferables(d: LodData): ArrayBuffer[] {
  return [d.matData, d.colorData, d.order, d.nodeStart, d.nodeEnd, d.nodeLeft, d.nodeRight, d.nodeSphere, d.nodeFeature]
    .map((a) => a.buffer as ArrayBuffer);
}

/**
 * Makes `material` read each instance's transform and color from textures. The `aInst` attribute is a leaf
 * id (one per LEAF_SIZE instances); instance = leaf * LEAF_SIZE + slot, and slots past the end are dropped.
 * With `impostor`, the geometry is a camera-facing triangle in the xy plane over a unit circle, shaded as a
 * sphere of the instance's radius (the normal is the sphere's, clamped to its rim outside the circle, as a
 * sub-pixel mesh's interpolated normals are). For sub-pixel levels, where it looks the same as a mesh at a
 * fraction of the cost.
 */
function readInstancesFromTextures(material: THREE.Material, matrices: THREE.DataTexture, colors: THREE.DataTexture, count: number, impostor = false) {
  material.customProgramCacheKey = () => (impostor ? "lod-instances-impostor" : "lod-instances");
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uInstMatrix = { value: matrices };
    shader.uniforms.uInstColor = { value: colors };
    shader.uniforms.uInstCount = { value: count };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
uniform highp sampler2D uInstMatrix;
uniform highp sampler2D uInstColor;
uniform uint uInstCount;
attribute uint aInst;
varying vec3 vInstColor;
ivec2 lodTexel(uint t) { return ivec2(int(t % ${TEX_WIDTH}u), int(t / ${TEX_WIDTH}u)); }`)
      .replace("#include <beginnormal_vertex>", `#include <beginnormal_vertex>
uint lodI = aInst * ${LEAF_SIZE}u + uint(gl_InstanceID % ${LEAF_SIZE});
bool lodDead = lodI >= uInstCount;
uint lodT = lodI * 3u;
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
vInstColor = texelFetch(uInstColor, lodTexel(lodI), 0).rgb;`)
      // Slots past the last instance: outside the clip volume, so nothing is drawn
      .replace("#include <clipping_planes_vertex>", `if (lodDead) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
#include <clipping_planes_vertex>`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
transformed = (lodM * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vInstColor;")
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb *= vInstColor;");
    if (!impostor) return;
    // Billboard at the sphere's front, facing the camera (view space)
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vImp;")
      .replace("#include <project_vertex>", `vImp = position.xy;
float lodR = length(lodM[0].xyz);
vec4 lodC = modelViewMatrix * vec4(lodM[3].xyz, 1.0);
vec4 mvPosition = vec4(lodC.xyz + vec3(position.xy * lodR, lodR), 1.0);
gl_Position = projectionMatrix * mvPosition;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vImp;")
      .replace("#include <normal_fragment_begin>", `vec2 lodV = vImp * min(1.0, inversesqrt(max(dot(vImp, vImp), 1e-8)));
float faceDirection = 1.0;
vec3 normal = vec3(lodV, sqrt(max(0.0, 1.0 - dot(lodV, lodV))));
vec3 nonPerturbedNormal = normal;`);
  };
}

/**
 * Rearranges order[lo..hi) so that order[k] holds the k-th smallest key, with smaller-or-equal keys before
 * it and larger-or-equal after (Hoare quickselect).
 */
function selectKth(order: Uint32Array, key: (i: number) => number, lo: number, hi: number, k: number) {
  let l = lo, r = hi - 1;
  while (r > l) {
    const a = key(order[l]!), b = key(order[(l + r) >> 1]!), c = key(order[r]!);
    const v = a < b ? (b < c ? b : a < c ? c : a) : (a < c ? a : b < c ? c : b); // median of three
    let i = l, j = r;
    while (i <= j) {
      while (key(order[i]!) < v) i++;
      while (key(order[j]!) > v) j--;
      if (i <= j) { const t = order[i]!; order[i] = order[j]!; order[j] = t; i++; j--; }
    }
    if (k <= j) r = j;
    else if (k >= i) l = i;
    else return;
  }
}

/** Instance data and hierarchy for a set (no GPU objects). */
export function computeLodData(input: LodDataInput, onProgress?: (p: LodBuildProgress) => void): LodData {
  const { count, writeMatrix, extentOf, writeColor } = input;

  // Centers, bounding radii and feature sizes, for the hierarchy
  const centers = new Float32Array(count * 3), extents = new Float32Array(count), features = new Float32Array(count);
  const m = new Float32Array(16), c = new Float32Array(3);
  for (let i = 0; i < count; i++) {
    if (onProgress && (i & 0xffff) === 0) onProgress({ stage: "instances", done: i, total: count });
    features[i] = writeMatrix(i, m, 0);
    centers[i * 3] = m[12]!; centers[i * 3 + 1] = m[13]!; centers[i * 3 + 2] = m[14]!;
    extents[i] = extentOf(i);
  }

  // Bounding-sphere hierarchy; splits at multiples of LEAF_SIZE keep every leaf full but the last
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  const nStart: number[] = [], nEnd: number[] = [], nLeft: number[] = [], nRight: number[] = [];
  const nSphere: number[] = [], nFeature: number[] = [];
  let placed = 0; // instances in finished leaves
  const build = (start: number, end: number): number => {
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
    const n = end - start;
    if (n <= LEAF_SIZE) {
      placed += n;
      if (onProgress && (id & 0x3ff) === 0) onProgress({ stage: "tree", done: placed, total: count });
      return id;
    }
    const axis = [0, 1, 2].reduce((best, a) => (max[a]! - min[a]! > max[best]! - min[best]! ? a : best), 0);
    const leaves = Math.ceil(n / LEAF_SIZE);
    const split = start + LEAF_SIZE * Math.max(1, Math.min(leaves - 1, Math.round(leaves / 2)));
    selectKth(order, (i) => centers[i * 3 + axis]!, start, end, split);
    nLeft[id] = build(start, split);
    nRight[id] = build(split, end);
    return id;
  };
  if (count > 0) build(0, count);

  // Transforms and colors in hierarchy order, padded to whole leaves
  const padded = Math.ceil(count / LEAF_SIZE) * LEAF_SIZE;
  const rows = Math.max(1, Math.ceil((padded * 3) / TEX_WIDTH));
  const matData = new Float32Array(TEX_WIDTH * rows * 4);
  const colorRows = Math.max(1, Math.ceil(padded / TEX_WIDTH));
  const colorData = new Uint8Array(TEX_WIDTH * colorRows * 4).fill(255);
  for (let k = 0; k < count; k++) {
    const i = order[k]!;
    writeMatrix(i, m, 0);
    for (let r = 0; r < 3; r++) {
      const o = (k * 3 + r) * 4;
      matData[o] = m[r]!; matData[o + 1] = m[4 + r]!; matData[o + 2] = m[8 + r]!; matData[o + 3] = m[12 + r]!;
    }
    if (writeColor) {
      writeColor(i, c, 0);
      colorData[k * 4] = Math.round(c[0]! * 255); colorData[k * 4 + 1] = Math.round(c[1]! * 255); colorData[k * 4 + 2] = Math.round(c[2]! * 255);
    }
  }

  return {
    count, matData, colorData, order,
    nodeStart: Uint32Array.from(nStart), nodeEnd: Uint32Array.from(nEnd),
    nodeLeft: Int32Array.from(nLeft), nodeRight: Int32Array.from(nRight),
    nodeSphere: Float32Array.from(nSphere), nodeFeature: Float32Array.from(nFeature),
  };
}

/** A level drawn as impostors (see readInstancesFromTextures) rather than as its geometry. */
export interface ImpostorLevel { impostor: THREE.BufferGeometry }

/** GPU objects for a set: textures for its data, one mesh per drawable level. */
export function createLodInstances(data: LodData, levels: (THREE.BufferGeometry | ImpostorLevel | null)[], levelMinPx: number[], material: THREE.Material): LodInstances {
  const { count } = data;
  const leafCount = Math.ceil(count / LEAF_SIZE);
  const matrices = new THREE.DataTexture(data.matData, TEX_WIDTH, data.matData.length / 4 / TEX_WIDTH, THREE.RGBAFormat, THREE.FloatType);
  const colors = new THREE.DataTexture(data.colorData, TEX_WIDTH, data.colorData.length / 4 / TEX_WIDTH, THREE.RGBAFormat, THREE.UnsignedByteType);
  matrices.needsUpdate = true;
  colors.needsUpdate = true;
  readInstancesFromTextures(material, matrices, colors, count);
  // Impostor levels get a material of their own (another shader)
  let impostorMaterial: THREE.Material | null = null;
  const materialFor = (level: THREE.BufferGeometry | ImpostorLevel) => {
    if (!("impostor" in level)) return material;
    if (!impostorMaterial) { impostorMaterial = material.clone(); readInstancesFromTextures(impostorMaterial, matrices, colors, count, true); }
    return impostorMaterial;
  };

  // One mesh per drawable level, drawing the leaves listed in its `aInst` attribute (LEAF_SIZE instances each)
  const group = new THREE.Group();
  const lists: (Uint32Array | null)[] = [];
  const meshes = levels.map((level) => {
    if (!level) { lists.push(null); return null; }
    const base = "impostor" in level ? level.impostor : level;
    const g = new THREE.InstancedBufferGeometry();
    for (const [name, attr] of Object.entries(base.attributes)) g.setAttribute(name, attr);
    if (base.index) g.setIndex(base.index);
    const list = new Uint32Array(Math.max(1, leafCount));
    lists.push(list);
    g.setAttribute("aInst", new THREE.InstancedBufferAttribute(list, 1, false, LEAF_SIZE).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = 0;
    const mesh = new THREE.Mesh(g, materialFor(level));
    mesh.frustumCulled = false; // culled per node here
    mesh.visible = false;
    mesh.raycast = () => {}; // hover picking uses its own grid
    group.add(mesh);
    return mesh;
  });

  return {
    group, count, meshes, levelMinPx, matData: data.matData, order: data.order,
    state: new Uint8Array(leafCount).fill(UNSET),
    nodeStart: data.nodeStart, nodeEnd: data.nodeEnd, nodeLeft: data.nodeLeft, nodeRight: data.nodeRight,
    nodeSphere: data.nodeSphere, nodeFeature: data.nodeFeature,
    lists, listCounts: new Uint32Array(levels.length),
    lastView: new Float64Array(33).fill(NaN),
    dispose() {
      for (const mesh of meshes) mesh?.geometry.dispose();
      for (const level of levels) (level && "impostor" in level ? level.impostor : level)?.dispose();
      matrices.dispose();
      colors.dispose();
      material.dispose();
      (impostorMaterial as THREE.Material | null)?.dispose();
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

/** Rebuild the per-level leaf lists for the current camera; returns true if anything drawn changed. */
export function updateLod(set: LodInstances, camera: THREE.Camera, viewportHeightPx: number): boolean {
  if (viewUnchanged(set, camera, viewportHeightPx)) return false;
  const nLevels = set.meshes.length, last = nLevels - 1, minPx = set.levelMinPx;
  const { state, lists, nodeStart, nodeEnd, nodeLeft, nodeRight, nodeSphere, nodeFeature } = set;
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
    // If the whole range sits clear of the thresholds (hysteresis included), every leaf gets the same level
    let level = 0;
    while (level < last && pxHi < minPx[level]! * (1 - HYSTERESIS)) level++;
    if (level === last || pxLo >= minPx[level]! * (1 + HYSTERESIS)) {
      for (let j = start / LEAF_SIZE, jEnd = Math.ceil(end / LEAF_SIZE); j < jEnd; j++) { state[j] = level; push(level, j); }
      continue;
    }
    const left = nodeLeft[n]!;
    if (left >= 0) {
      if (top + 2 > stack.length) { const s = new Int32Array(stack.length * 2); s.set(stack); stack = s; }
      // Nearer child last, so it is visited first: lists run roughly front to back, and the depth test
      // rejects hidden pixels before they are shaded
      const right = nodeRight[n]!;
      const lx = nodeSphere[left * 4]! - cx, ly = nodeSphere[left * 4 + 1]! - cy, lz = nodeSphere[left * 4 + 2]! - cz;
      const rx = nodeSphere[right * 4]! - cx, ry = nodeSphere[right * 4 + 1]! - cy, rz = nodeSphere[right * 4 + 2]! - cz;
      const leftNearer = lx * lx + ly * ly + lz * lz <= rx * rx + ry * ry + rz * rz;
      stack[top++] = leftNearer ? right : left;
      stack[top++] = leftNearer ? left : right;
      continue;
    }
    // Leaf straddling a threshold: its largest feature at its nearest point, with hysteresis
    const j = start / LEAF_SIZE;
    let l = state[j] === UNSET ? last : state[j]!;
    while (l > 0 && pxHi >= minPx[l - 1]! * (1 + HYSTERESIS)) l--;
    while (l < last && pxHi < minPx[l]! * (1 - HYSTERESIS)) l++;
    state[j] = l;
    push(l, j);
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
    geom.instanceCount = n * LEAF_SIZE;
    mesh.visible = n > 0;
  }
  return changed;
}

const rayO = new THREE.Vector3();
const rayD = new THREE.Vector3();
let rayStack = new Int32Array(256);
let rayStackT = new Float64Array(256);

/**
 * Index of the nearest instance hit by a world-space ray, for sets of spheres (uniform scale: radius is the
 * matrix's first diagonal element), or -1. Walks the hierarchy nearest-first and skips nodes whose entry is
 * beyond the best hit so far, so only the leaves along the ray are tested.
 */
export function raycastSpheres(set: LodInstances, origin: THREE.Vector3, direction: THREE.Vector3): number {
  if (set.count === 0) return -1;
  invWorld.copy(set.group.matrixWorld).invert();
  rayO.copy(origin).applyMatrix4(invWorld);
  rayD.copy(direction).transformDirection(invWorld);
  const ox = rayO.x, oy = rayO.y, oz = rayO.z, dx = rayD.x, dy = rayD.y, dz = rayD.z;
  const { nodeStart, nodeEnd, nodeLeft, nodeRight, nodeSphere, matData, order } = set;
  /** Entry distance along the ray into a sphere (0 if the origin is inside), or Infinity on a miss. */
  const enter = (cx: number, cy: number, cz: number, r: number) => {
    const px = ox - cx, py = oy - cy, pz = oz - cz;
    const b = px * dx + py * dy + pz * dz, c = px * px + py * py + pz * pz - r * r;
    if (c <= 0) return 0;
    if (b > 0) return Infinity; // outside and pointing away
    const disc = b * b - c;
    return disc < 0 ? Infinity : -b - Math.sqrt(disc);
  };
  const nodeEnter = (n: number) => enter(nodeSphere[n * 4]!, nodeSphere[n * 4 + 1]!, nodeSphere[n * 4 + 2]!, nodeSphere[n * 4 + 3]!);

  let best = -1, bestT = Infinity, top = 0;
  const t0 = nodeEnter(0);
  if (t0 === Infinity) return -1;
  rayStack[0] = 0; rayStackT[0] = t0; top = 1;
  while (top > 0) {
    top--;
    const n = rayStack[top]!;
    if (rayStackT[top]! >= bestT) continue;
    const left = nodeLeft[n]!;
    if (left < 0) {
      for (let k = nodeStart[n]!, end = nodeEnd[n]!; k < end; k++) {
        const o = k * 12; // rows 0..2 of instance k: translation in column 3, radius on the diagonal
        const t = enter(matData[o + 3]!, matData[o + 7]!, matData[o + 11]!, matData[o]!);
        if (t < bestT && t > 0) { bestT = t; best = k; }
      }
      continue;
    }
    const right = nodeRight[n]!;
    const tl = nodeEnter(left), tr = nodeEnter(right);
    if (top + 2 > rayStack.length) {
      const s2 = new Int32Array(rayStack.length * 2); s2.set(rayStack); rayStack = s2;
      const t2 = new Float64Array(rayStackT.length * 2); t2.set(rayStackT); rayStackT = t2;
    }
    // Farther child first on the stack, so the nearer one is walked first
    const [nearN, nearT, farN, farT] = tl <= tr ? [left, tl, right, tr] : [right, tr, left, tl];
    if (farT < bestT) { rayStack[top] = farN; rayStackT[top] = farT; top++; }
    if (nearT < bestT) { rayStack[top] = nearN; rayStackT[top] = nearT; top++; }
  }
  return best < 0 ? -1 : order[best]!;
}
