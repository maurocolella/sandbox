/*
 Title: pathTrace
 Description: Offline path-traced renders of the current view (three-gpu-pathtracer), in their own WebGL
 context and canvas so the interactive view stays usable:
 - The render scene is rebuilt as plain triangles: atoms and bonds from the structure data (the live view
   draws them through LOD instancing the tracer can't read), and every other visible mesh whose ancestor
   carries a `userData.ptRole` (cartoon, ligands, binding site, interactions, surface, pockets), instances
   expanded, merged per role into one mesh with vertex colours.
 - Materials by role: matte protein, glossy clear-coated ligands so they read first, emissive interaction
   dashes; studio lighting from a gradient environment and one large soft key light.
 - Emphasis: with a ligand selected, the context (cartoon, atoms, bonds, surface) is desaturated (lightness
   kept, so it doesn't wash out) so the ligand, its binding site and interactions keep full colour; depth of field focused on the ligand
   (or the view's centre); and depth cueing as
   PyMOL's: far geometry fades toward the background colour, by a rasterised depth pass of the same view.
 - The tracer's background is transparent; each frame is composited over the exact background colour (so
   it matches the app's, untouched by tone mapping): isolated bright pixels (unconverged glossy paths) are
   replaced by their neighbours' mean, remaining grain is smoothed by a 3x3 filter over neighbours of similar
   colour (so edges stay sharp), then tone mapping, a gentle contrast curve and saturation lift, and
   the depth cue.
 Samples accumulate progressively; the canvas shows the image so far.
*/
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { WebGLPathTracer, PhysicalCamera, GradientEquirectTexture } from "three-gpu-pathtracer";

export type PtRole = "cartoon" | "atoms" | "bonds" | "ligand" | "swap" | "site" | "interaction" | "surface" | "pocket";

export interface PathTraceSettings {
  width: number;
  height: number;
  samples: number;
  /** Depth of field strength, 0 (off) to 1. */
  depthOfField: number;
  /** Depth cue (fade toward the background with distance), 0 (off) to 1. */
  fog: number;
  /** Point kept sharp (the selected ligand), else the view's centre. */
  focus?: THREE.Vector3 | null;
  /** How much the context recedes when a ligand is in focus, 0 to 1. */
  emphasis: number;
  background: string;
}

export interface PathTraceProgress {
  stage: "preparing" | "rendering" | "done";
  samples: number;
  total: number;
  elapsed: number; // ms
  canvas: HTMLCanvasElement;
  /** Parts left out to stay within the triangle budget. */
  omitted: string[];
}

export interface StructureData {
  atoms?: { positions: ArrayLike<number>; radii: ArrayLike<number>; colors?: ArrayLike<number>; count: number; radiusScale: number } | null;
  bonds?: { positions: ArrayLike<number>; indexA: ArrayLike<number>; indexB: ArrayLike<number>; count: number } | null;
}

const TRIANGLE_BUDGET = 12_000_000;

// The tracer reads Scene rotations added in three r162; zero rotations until three is upgraded
const sceneProto = THREE.Scene.prototype as unknown as Record<string, unknown>;
if (!("backgroundRotation" in sceneProto)) {
  sceneProto.backgroundRotation = new THREE.Euler();
  sceneProto.environmentRotation = new THREE.Euler();
}
const BOND_RADIUS = 0.06, BOND_COLOR = new THREE.Color(0xaaaaaa);

/** Growable triangle soup with vertex colours. */
class Batch {
  pos = new Float32Array(1 << 16); nor = new Float32Array(1 << 16); col = new Float32Array(1 << 16); idx = new Uint32Array(1 << 16);
  nv = 0; ni = 0;
  private grow<T extends Float32Array | Uint32Array>(a: T, need: number): T {
    if (need <= a.length) return a;
    let n = a.length; while (n < need) n *= 2;
    const b = new (a.constructor as new (n: number) => T)(n); b.set(a); return b;
  }
  reserve(v: number, i: number) {
    this.pos = this.grow(this.pos, (this.nv + v) * 3); this.nor = this.grow(this.nor, (this.nv + v) * 3);
    this.col = this.grow(this.col, (this.nv + v) * 3); this.idx = this.grow(this.idx, this.ni + i);
  }
  /** Appends a template geometry transformed by `m`, in one colour or its own vertex colours. */
  add(g: THREE.BufferGeometry, m: THREE.Matrix4, nm: THREE.Matrix3, color: THREE.Color | null) {
    const P = g.attributes.position!, N = g.attributes.normal, C = g.attributes.color, I = g.index;
    const nv = P.count, ni = I ? I.count : nv;
    this.reserve(nv, ni);
    const v = new THREE.Vector3(), base = this.nv;
    for (let k = 0; k < nv; k++) {
      v.fromBufferAttribute(P, k).applyMatrix4(m);
      this.pos.set([v.x, v.y, v.z], (base + k) * 3);
      if (N) { v.fromBufferAttribute(N as THREE.BufferAttribute, k).applyMatrix3(nm).normalize(); this.nor.set([v.x, v.y, v.z], (base + k) * 3); }
      const o = (base + k) * 3;
      if (color) { this.col[o] = color.r; this.col[o + 1] = color.g; this.col[o + 2] = color.b; }
      else if (C) { this.col[o] = C.getX(k); this.col[o + 1] = C.getY(k); this.col[o + 2] = C.getZ(k); }
      else { this.col[o] = 1; this.col[o + 1] = 1; this.col[o + 2] = 1; }
    }
    for (let k = 0; k < ni; k++) this.idx[this.ni + k] = base + (I ? I.getX(k) : k);
    this.nv += nv; this.ni += ni;
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos.slice(0, this.nv * 3), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(this.nor.slice(0, this.nv * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(this.col.slice(0, this.nv * 3), 3));
    g.setIndex(new THREE.BufferAttribute(this.idx.slice(0, this.ni), 1));
    return g;
  }
}

function roleMaterial(role: PtRole, source: THREE.Material | null): THREE.MeshPhysicalMaterial {
  const base = { vertexColors: true, color: 0xffffff, metalness: 0 };
  const opacity = (source as THREE.MeshStandardMaterial | null)?.opacity ?? 1;
  switch (role) {
    case "ligand": case "swap": return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.05 });
    case "site": return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.35, clearcoat: 0.5, clearcoatRoughness: 0.2 });
    case "interaction": {
      const c = (source as THREE.MeshBasicMaterial | null)?.color ?? new THREE.Color(1, 1, 1);
      return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.4, emissive: c, emissiveIntensity: 0.6 });
    }
    case "surface": return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.6, sheen: 0.35, sheenRoughness: 0.5, sheenColor: 0xffffff, transparent: opacity < 1, opacity });
    case "pocket": return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08, transparent: true, opacity: 0.7 });
    default: return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.5, clearcoat: 0.25, clearcoatRoughness: 0.4 });
  }
}

/** Tone-mapped accumulation over the background colour, far geometry faded toward it (straight alpha). */
function compositeMaterial(depth: THREE.DepthTexture, background: THREE.Color, camera: THREE.PerspectiveCamera, fogNear: number, fogFar: number, fog: number, width: number, height: number) {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: null }, depthMap: { value: depth }, texel: { value: new THREE.Vector2(1 / width, 1 / height) }, background: { value: background.clone().convertLinearToSRGB() },
      cameraNear: { value: camera.near }, cameraFar: { value: camera.far }, fogNear: { value: fogNear }, fogFar: { value: fogFar }, fog: { value: fog },
    },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: `
      #include <packing>
      uniform sampler2D map; uniform sampler2D depthMap; uniform vec3 background; uniform vec2 texel;
      uniform float cameraNear, cameraFar, fogNear, fogFar, fog;
      varying vec2 vUv;
      float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
      void main() {
        vec4 c = texture2D(map, vUv);
        // One pass over the 8 neighbours:
        // - a pixel far brighter than all of them is an unconverged spike: take their mean;
        // - otherwise a blend with those of similar colour (compressed HDR)
        // Kept simple: richer versions (exp weights, depth per neighbour, a second loop) fail pipeline
        // creation on ANGLE's Vulkan backend
        vec3 c0 = c.rgb / (1.0 + c.rgb), sum = vec3(0.0), acc = c.rgb;
        float brightest = 0.0, wsum = 1.0;
        for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
          if (x == 0 && y == 0) continue;
          vec2 o = vec2(float(x), float(y));
          vec3 n = texture2D(map, vUv + o * texel).rgb;
          vec3 dc = n / (1.0 + n) - c0;
          float sc = dot(dc, dc) / 0.004;
          float w = 1.0 / ((1.0 + 0.5 * dot(o, o)) * (1.0 + sc + sc * sc));
          sum += n; brightest = max(brightest, luma(n));
          acc += n * w; wsum += w;
        }
        c.rgb = luma(c.rgb) > brightest * 1.3 + 0.03 ? sum / 8.0 : acc / wsum;
        vec4 rgb = linearToOutputTexel(vec4(toneMapping(c.rgb), 1.0));
        // Gentle S-curve and saturation lift
        rgb.rgb = mix(rgb.rgb, rgb.rgb * rgb.rgb * (3.0 - 2.0 * rgb.rgb), 0.35);
        rgb.rgb = clamp(mix(vec3(luma(rgb.rgb)), rgb.rgb, 1.12), 0.0, 1.0);
        float d = texture2D(depthMap, vUv).x;
        float dist = d < 1.0 ? -perspectiveDepthToViewZ(d, cameraNear, cameraFar) : fogFar;
        rgb.rgb = mix(rgb.rgb, background, fog * smoothstep(fogNear, fogFar, dist));
        gl_FragColor = vec4(mix(background, rgb.rgb, clamp(c.a, 0.0, 1.0)), 1.0);
      }`,
    toneMapped: true,
    depthTest: false, depthWrite: false,
  });
}

/** The render scene: one merged mesh per role (and per colour for interaction dashes). */
const CONTEXT: PtRole[] = ["cartoon", "atoms", "bonds", "surface"];

/** Desaturates vertex colours in place (linear RGB) toward their own luminance, by `t` (0..1). */
function recede(colors: Float32Array, t: number) {
  for (let i = 0; i < colors.length; i += 3) {
    const l = 0.2126 * colors[i]! + 0.7152 * colors[i + 1]! + 0.0722 * colors[i + 2]!;
    for (let k = 0; k < 3; k++) colors[i + k] = colors[i + k]! + (l - colors[i + k]!) * t;
  }
}

function buildScene(live: THREE.Object3D, data: StructureData, emphasis: number): { scene: THREE.Scene; bounds: THREE.Box3; omitted: string[] } {
  const batches = new Map<string, { role: PtRole; batch: Batch; source: THREE.Material | null }>();
  const batchFor = (role: PtRole, source: THREE.Material | null) => {
    const key = role === "interaction" ? `${role}:${(source as THREE.MeshBasicMaterial).color.getHex()}` : role;
    let b = batches.get(key);
    if (!b) batches.set(key, (b = { role, batch: new Batch(), source }));
    return b.batch;
  };
  const omitted: string[] = [];
  let triangles = 0;
  const m = new THREE.Matrix4(), nm = new THREE.Matrix3(), im = new THREE.Matrix4(), c = new THREE.Color();

  // Tagged meshes of the live scene
  live.updateMatrixWorld(true);
  const visit = (o: THREE.Object3D, role: PtRole | null) => {
    if (!o.visible) return;
    const r = (o.userData.ptRole as PtRole | undefined) ?? role;
    const mesh = o as THREE.Mesh;
    if (r && mesh.isMesh) {
      const material = mesh.material as THREE.Material;
      // Depth-only prepasses carry no colour
      if (material.colorWrite !== false && mesh.geometry.attributes.position) {
        const own = (material as THREE.MeshStandardMaterial).color ?? null;
        const batch = batchFor(r, material);
        const inst = o as THREE.InstancedMesh;
        if (inst.isInstancedMesh) {
          for (let i = 0; i < inst.count; i++) {
            inst.getMatrixAt(i, im);
            m.multiplyMatrices(o.matrixWorld, im); nm.getNormalMatrix(m);
            if (inst.instanceColor) inst.getColorAt(i, c); else c.setRGB(1, 1, 1);
            if (own && r !== "interaction") c.multiply(own);
            batch.add(mesh.geometry, m, nm, r === "interaction" ? new THREE.Color(own ?? 0xffffff) : c);
          }
          triangles += inst.count * ((mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3);
        } else {
          nm.getNormalMatrix(o.matrixWorld);
          batch.add(mesh.geometry, o.matrixWorld, nm, mesh.geometry.attributes.color ? null : own ? c.copy(own) : null);
          triangles += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
        }
      }
    }
    for (const child of o.children) visit(child, r);
  };
  visit(live, null);

  // Atoms and bonds from the data, at the finest detail that fits the budget
  const atoms = data.atoms;
  if (atoms && atoms.count > 0) {
    const detail = [3, 2, 1, 0].find((d) => atoms.count * 20 * 4 ** d + triangles <= TRIANGLE_BUDGET);
    if (detail === undefined) omitted.push(`atoms (${atoms.count.toLocaleString()})`);
    else {
      const sphere = mergeVertices(new THREE.IcosahedronGeometry(1, detail));
      sphere.computeVertexNormals();
      const batch = batchFor("atoms", null), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      for (let i = 0; i < atoms.count; i++) {
        const r = atoms.radii[i]! * atoms.radiusScale;
        m.compose(p.set(atoms.positions[i * 3]!, atoms.positions[i * 3 + 1]!, atoms.positions[i * 3 + 2]!), q, s.set(r, r, r));
        nm.getNormalMatrix(m);
        // As the live view: 0-255 element colours used as linear values
        if (atoms.colors) c.setRGB(atoms.colors[i * 3]! / 255, atoms.colors[i * 3 + 1]! / 255, atoms.colors[i * 3 + 2]! / 255); else c.setRGB(1, 1, 1);
        batch.add(sphere, m, nm, c);
      }
      triangles += atoms.count * 20 * 4 ** detail;
      sphere.dispose();
    }
  }
  const bonds = data.bonds;
  if (bonds && bonds.count > 0) {
    const sides = [10, 6].find((n) => bonds.count * 2 * n + triangles <= TRIANGLE_BUDGET);
    if (sides === undefined) omitted.push(`bonds (${bonds.count.toLocaleString()})`);
    else {
      const cyl = new THREE.CylinderGeometry(1, 1, 1, sides, 1, true);
      const batch = batchFor("bonds", null), up = new THREE.Vector3(0, 1, 0), d = new THREE.Vector3(), mid = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      const P = bonds.positions;
      for (let k = 0; k < bonds.count; k++) {
        const a = bonds.indexA[k]! * 3, b = bonds.indexB[k]! * 3;
        d.set(P[b]! - P[a]!, P[b + 1]! - P[a + 1]!, P[b + 2]! - P[a + 2]!);
        const len = d.length();
        if (len < 1e-6) continue;
        q.setFromUnitVectors(up, d.divideScalar(len));
        m.compose(mid.set((P[a]! + P[b]!) / 2, (P[a + 1]! + P[b + 1]!) / 2, (P[a + 2]! + P[b + 2]!) / 2), q, s.set(BOND_RADIUS, len, BOND_RADIUS));
        nm.getNormalMatrix(m);
        batch.add(cyl, m, nm, BOND_COLOR);
      }
      cyl.dispose();
    }
  }

  const scene = new THREE.Scene();
  const bounds = new THREE.Box3();
  for (const { role, batch, source } of batches.values()) {
    if (batch.ni === 0) continue;
    const g = batch.geometry();
    if (emphasis > 0 && CONTEXT.includes(role)) recede(g.attributes.color!.array as Float32Array, emphasis * 0.9);
    g.computeBoundingBox();
    bounds.union(g.boundingBox!);
    scene.add(new THREE.Mesh(g, roleMaterial(role, source)));
  }
  return { scene, bounds, omitted };
}

/**
 * Starts a render of `live` (the interactive scene's content) as seen by `liveCamera` looking at `target`.
 * Returns a cancel function; `onProgress` is called after each sample, then once done.
 */
export function startPathTrace(
  live: THREE.Object3D, liveCamera: THREE.PerspectiveCamera, target: THREE.Vector3, data: StructureData,
  settings: PathTraceSettings, onProgress: (p: PathTraceProgress) => void,
): () => void {
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(1);
  renderer.setSize(settings.width, settings.height, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  const t0 = performance.now();
  let cancelled = false, frame = 0;
  const report = (stage: PathTraceProgress["stage"], samples: number, omitted: string[]) =>
    onProgress({ stage, samples, total: settings.samples, elapsed: performance.now() - t0, canvas, omitted });

  const disposables: { dispose(): void }[] = [];
  const cleanup = () => {
    cancelAnimationFrame(frame);
    for (const d of disposables) d.dispose();
    renderer.dispose();
  };

  // Let the "preparing" state paint before the (synchronous) scene and BVH build
  report("preparing", 0, []);
  const startTimer = setTimeout(() => {
    if (cancelled) return;
    const { scene, bounds, omitted } = buildScene(live, data, settings.focus ? settings.emphasis : 0);
    scene.traverse((o) => { const mesh = o as THREE.Mesh; if (mesh.isMesh) disposables.push(mesh.geometry, mesh.material as THREE.Material); });

    const background = new THREE.Color(settings.background);
    scene.background = null; // transparent: composited over the background below
    // Studio light: bright from above, dimmer below, and a soft key light above the camera's left shoulder
    const env = new GradientEquirectTexture(64);
    env.topColor.set(0xffffff); env.bottomColor.set(0x181818); env.exponent = 1.5; env.update();
    disposables.push(env);
    scene.environment = env;
    (scene as THREE.Scene & { environmentIntensity?: number }).environmentIntensity = 1.0;
    const size = bounds.getSize(new THREE.Vector3()).length() || 50;
    const camera = new PhysicalCamera(liveCamera.fov, settings.width / settings.height, liveCamera.near, liveCamera.far);
    camera.position.copy(liveCamera.position);
    camera.quaternion.copy(liveCamera.quaternion);
    camera.updateMatrixWorld();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const key = new THREE.RectAreaLight(0xffffff, 10, size * 0.6, size * 0.6);
    key.position.copy(camera.position).addScaledVector(up, size * 0.6).addScaledVector(right, -size * 0.5);
    key.lookAt(target);
    scene.add(key);

    // Depth of field: aperture (world units) grows with the focus distance
    const focusPoint = settings.focus ?? target;
    camera.focusDistance = camera.position.distanceTo(focusPoint);
    if (settings.depthOfField > 0) {
      camera.apertureBlades = 6;
      camera.bokehSize = settings.depthOfField * camera.focusDistance * 0.05 * 2000; // radius = bokehSize * 0.5e-3
    } else camera.bokehSize = 0;

    // Depth of the view, for the depth cue: rasterised once
    const depthTarget = new THREE.WebGLRenderTarget(settings.width, settings.height, { depthTexture: new THREE.DepthTexture(settings.width, settings.height, THREE.FloatType) });
    scene.overrideMaterial = new THREE.MeshBasicMaterial({ colorWrite: false });
    renderer.setRenderTarget(depthTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    disposables.push(scene.overrideMaterial, depthTarget, depthTarget.depthTexture!);
    scene.overrideMaterial = null;
    // The cue starts a third of the way into the scene's depth, as PyMOL's fog_start
    const sphere = bounds.getBoundingSphere(new THREE.Sphere()), centreDist = camera.position.distanceTo(sphere.center);
    const near = Math.max(camera.near, centreDist - sphere.radius), far = centreDist + sphere.radius;
    const composite = compositeMaterial(depthTarget.depthTexture!, background, camera, near + (far - near) / 3, far, settings.fog, settings.width, settings.height);
    const quad = new FullScreenQuad(composite);
    disposables.push(composite, quad);

    const pt = new WebGLPathTracer(renderer);
    pt.renderDelay = 0; pt.fadeDuration = 0; pt.minSamples = 0;
    pt.dynamicLowRes = false; pt.rasterizeScene = false; pt.renderToCanvas = true;
    pt.bounces = 6; pt.filterGlossyFactor = 0.8;
    // Smaller tiles per frame at high resolutions keep each GPU submission short
    const tiles = Math.max(1, Math.ceil(Math.max(settings.width, settings.height) / 1400));
    pt.tiles.set(tiles, tiles);
    pt.renderToCanvasCallback = (target, r) => {
      composite.uniforms.map!.value = target.texture;
      quad.render(r);
    };
    pt.setScene(scene, camera);

    const loop = () => {
      if (cancelled) return;
      pt.renderSample();
      const samples = Math.floor(pt.samples);
      if (samples >= settings.samples) { cleanupKeepCanvas(); return; }
      report("rendering", samples, omitted);
      frame = requestAnimationFrame(loop);
    };
    // Done: free GPU resources but keep the canvas pixels (preserveDrawingBuffer) by copying them out
    const cleanupKeepCanvas = () => {
      const copy = document.createElement("canvas");
      copy.width = canvas.width; copy.height = canvas.height;
      copy.getContext("2d")!.drawImage(canvas, 0, 0);
      onProgress({ stage: "done", samples: Math.floor(pt.samples), total: settings.samples, elapsed: performance.now() - t0, canvas: copy, omitted });
      cleanup();
    };
    frame = requestAnimationFrame(loop);
  }, 30);

  return () => {
    cancelled = true;
    clearTimeout(startTimer);
    cleanup();
  };
}
