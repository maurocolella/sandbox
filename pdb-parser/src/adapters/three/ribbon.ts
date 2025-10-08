import * as THREE from "three";
import type { MolScene } from "../../types/molScene.js";

export interface RibbonOptions {
  radius?: number; // tube radius
  tubularSegmentsPerPoint?: number; // segments per backbone point, default 4
  radialSegments?: number; // tube radial segments, default 12
  color?: number; // material color, default 0xffffff
  materialKind?: "basic" | "lambert" | "standard";
}

/**
 * Build a ribbon/cartoon-like tube along the parsed backbone polyline.
 * This uses TubeGeometry over each backbone segment to create a smooth path.
 */
export function makeRibbonMesh(scene: MolScene, opts: RibbonOptions = {}): THREE.Group | null {
  if (!scene.backbone) return null;

  const positions = scene.backbone.positions;
  const segments = scene.backbone.segments;
  const residueOfPoint = scene.backbone.residueOfPoint;

  const radius = opts.radius ?? 0.4;
  const radialSegments = Math.max(3, opts.radialSegments ?? 12);
  const tubularPerPoint = Math.max(1, opts.tubularSegmentsPerPoint ?? 4);

  const materialKind = opts.materialKind ?? "standard";
  const group = new THREE.Group();
  const tmp = new THREE.Vector3();

  // Build residue->chain map once
  const residueCount = scene.tables?.residues?.length ?? 0;
  const residueToChain = new Int32Array(Math.max(1, residueCount)).fill(-1);
  if (scene.atoms.residueIndex && scene.atoms.chainIndex) {
    const N = scene.atoms.count;
    for (let i = 0; i < N; i++) {
      const ri = scene.atoms.residueIndex![i]!;
      if (ri >= 0 && ri < residueToChain.length && residueToChain[ri] === -1) {
        residueToChain[ri] = scene.atoms.chainIndex![i]!;
      }
    }
  }

  // Nice-color-like palette
  const palette = [
    0x69d2e7, 0xa7dbd8, 0xe0e4cc, 0xf38630, 0xfa6900,
    0xe94e77, 0xd68189, 0xc6a49a, 0xc6e5d9, 0xf4ead5,
    0xecd078, 0xd95b43, 0xc02942, 0x542437, 0x53777a,
    0x556270, 0x4ecdc4, 0xc7f464, 0xff6b6b, 0xc44d58,
  ];
  const matCache = new Map<number, THREE.Material>();
  const makeMaterial = (hex: number): THREE.Material => {
    if (materialKind === "basic") return new THREE.MeshBasicMaterial({ color: hex });
    if (materialKind === "lambert") return new THREE.MeshLambertMaterial({ color: hex });
    return new THREE.MeshStandardMaterial({ color: hex, metalness: 0.08, roughness: 0.72 });
  };
  const getMaterialForChain = (chainIdx: number): THREE.Material => {
    const key = chainIdx >= 0 ? chainIdx : 0;
    let m = matCache.get(key);
    if (!m) {
      const hex = palette[key % palette.length];
      m = makeMaterial(hex);
      matCache.set(key, m);
    }
    return m;
  };

  for (let s = 0; s < segments.length; s += 2) {
    const start = segments[s];
    const end = segments[s + 1];
    const count = end - start;
    if (count < 2) continue;

    const pts: THREE.Vector3[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const idx = (start + i) * 3;
      tmp.set(positions[idx], positions[idx + 1], positions[idx + 2]);
      pts[i] = tmp.clone();
    }
    const curve = new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.5);
    const tubularSegments = Math.max(8, count * tubularPerPoint);
    const geom = new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, false);
    // Determine chain index for this segment via first residueOfPoint
    const firstResidue = residueOfPoint ? residueOfPoint[start] : -1;
    const chainIdx = firstResidue >= 0 ? residueToChain[firstResidue] : -1;
    const mat = getMaterialForChain(chainIdx);
    const mesh = new THREE.Mesh(geom, mat);
    group.add(mesh);
  }

  return group;
}

export interface FlatRibbonOptions {
  width?: number; // ribbon width
  segmentsPerPoint?: number; // samples per backbone point, default 4
  color?: number; // material color, default 0xffffff
  materialKind?: "basic" | "lambert" | "standard";
  doubleSided?: boolean; // render both sides, default true
  thickness?: number; // absolute thickness; if omitted, uses width * 0.15
}

/**
 * Build a flat ribbon (strip) along the backbone with minimal twist using
 * parallel transport frames along a Catmull-Rom curve fit to each backbone segment.
 */
export function makeFlatRibbonMesh(scene: MolScene, opts: FlatRibbonOptions = {}): THREE.Group | null {
  if (!scene.backbone) return null;

  const positions = scene.backbone.positions;
  const segments = scene.backbone.segments;
  const residueOfPoint = scene.backbone.residueOfPoint;

  const width = opts.width ?? 1.2; // visual default width
  const samplesPerPoint = Math.max(1, opts.segmentsPerPoint ?? 4);
  const materialKind = opts.materialKind ?? "standard";
  const color = opts.color ?? 0xffffff;
  const doubleSided = opts.doubleSided ?? true;
  const thicknessParam = opts.thickness; // may be undefined => derived from width

  const group = new THREE.Group();

  const tmp = new THREE.Vector3();
  const tPrev = new THREE.Vector3();
  const nPrev = new THREE.Vector3();

  // Residue -> chain index map (first atom per residue)
  const residueCount = scene.tables?.residues?.length ?? 0;
  const residueToChain = new Int32Array(Math.max(1, residueCount)).fill(-1);
  if (scene.atoms.residueIndex && scene.atoms.chainIndex) {
    const N = scene.atoms.count;
    for (let i = 0; i < N; i++) {
      const ri = scene.atoms.residueIndex![i]!;
      if (ri >= 0 && ri < residueToChain.length && residueToChain[ri] === -1) {
        residueToChain[ri] = scene.atoms.chainIndex![i]!;
      }
    }
  }

  // Nice-color-like palette for chains
  const palette = [
    0x69d2e7, 0xa7dbd8, 0xe0e4cc, 0xf38630, 0xfa6900,
    0xe94e77, 0xd68189, 0xc6a49a, 0xc6e5d9, 0xf4ead5,
    0xecd078, 0xd95b43, 0xc02942, 0x542437, 0x53777a,
    0x556270, 0x4ecdc4, 0xc7f464, 0xff6b6b, 0xc44d58,
  ] as const;

  // Build residue -> secondary kind map (0 loop, 1 helix, 2 sheet)
  const kindByResidue = new Uint8Array(residueCount);
  if (scene.tables?.secondary) {
    for (const span of scene.tables.secondary) {
      const kindVal = span.kind === "helix" ? 1 : 2;
      for (let ri = span.startResidue; ri <= span.endResidue; ri++) {
        if (ri >= 0 && ri < residueCount) kindByResidue[ri] = kindVal;
      }
    }
  }
  // For sheet arrowheads: distance to end of sheet (in residues)
  const sheetEndResidue = new Int32Array(residueCount).fill(-1);
  if (scene.tables?.secondary) {
    for (const span of scene.tables.secondary) {
      if (span.kind !== "sheet") continue;
      for (let ri = span.startResidue; ri <= span.endResidue; ri++) {
        sheetEndResidue[ri] = span.endResidue;
      }
    }
  }

  function parallelTransportNormal(n: THREE.Vector3, t0: THREE.Vector3, t1: THREE.Vector3): THREE.Vector3 {
    // Rotate normal n from tangent t0 to t1 with minimal rotation (Rodrigues around axis v = t0 x t1)
    const v = new THREE.Vector3().crossVectors(t0, t1);
    const s = v.length();
    if (s < 1e-6) return n.clone();
    v.multiplyScalar(1 / s);
    const c = THREE.MathUtils.clamp(t0.dot(t1), -1, 1);
    const theta = Math.acos(c);
    // Rodrigues' rotation formula
    const nRot = n.clone().multiplyScalar(Math.cos(theta))
      .add(new THREE.Vector3().crossVectors(v, n).multiplyScalar(Math.sin(theta)))
      .add(v.clone().multiplyScalar(v.dot(n) * (1 - Math.cos(theta))));
    return nRot;
  }

  for (let s = 0; s < segments.length; s += 2) {
    const start = segments[s];
    const end = segments[s + 1];
    const count = end - start;
    if (count < 2) continue;

    const pts: THREE.Vector3[] = new Array(count);
    const resLocal: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const idx = (start + i) * 3;
      tmp.set(positions[idx], positions[idx + 1], positions[idx + 2]);
      pts[i] = tmp.clone();
      resLocal[i] = residueOfPoint ? residueOfPoint[start + i] : -1;
    }

    const curve = new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.5);
    const segs = Math.max(8, count * samplesPerPoint);

    // 4 vertices per sample (ring): v0: +n +b, v1: -n +b, v2: -n -b, v3: +n -b
    const verts: number[] = [];
    const indices: number[] = [];

    // Initialize frame
    const p0 = curve.getPoint(0);
    const p1 = curve.getPoint(1 / segs);
    const t0 = new THREE.Vector3().subVectors(p1, p0).normalize();
    const arbitrary = Math.abs(t0.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    let n = new THREE.Vector3().crossVectors(t0, arbitrary).normalize();

    const baseLoop = Math.max(0.2, width * 0.6);
    const baseHelix = width * 1.0;
    const baseSheet = width * 1.4;

    // Helix twist parameters: ~3.6 residues per turn
    const turnPerResidue = (2 * Math.PI) / 3.6; // radians
    const samplesPerResidue = segs / Math.max(1, (count - 1));

    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const p = curve.getPoint(u);
      const t = curve.getTangent(u).normalize();
      if (i > 0) n = parallelTransportNormal(n, tPrev, t).normalize();
      tPrev.copy(t);
      nPrev.copy(n);

      // Determine residue and secondary kind at this sample
      const approxIdx = Math.max(0, Math.min(count - 1, Math.round(u * (count - 1))));
      const residueIdx = resLocal[approxIdx] ?? -1;
      const kind = residueIdx >= 0 ? kindByResidue[residueIdx] : 0; // 0 loop, 1 helix, 2 sheet

      // Width per kind
      let w = kind === 1 ? baseHelix : kind === 2 ? baseSheet : baseLoop;

      // Sheet arrowhead: taper last ~2 residues to a point
      if (kind === 2 && residueIdx >= 0) {
        const endRi = sheetEndResidue[residueIdx];
        if (endRi >= 0) {
          const distToEnd = endRi - residueIdx; // in residues
          const tipSpan = 2; // residues
          if (distToEnd <= tipSpan) {
            const tTip = Math.max(0, Math.min(1, distToEnd / tipSpan));
            // wider before tip, then taper to 0
            const widen = 1.3 - 0.3 * (1 - tTip);
            w = w * widen * tTip;
          }
        }
      }

      // Helix twist: rotate normal by twist per sample when in helix
      if (kind === 1) {
        const twistPerSample = turnPerResidue / Math.max(1, samplesPerResidue);
        n = n.clone().applyAxisAngle(t, twistPerSample);
      }

      const halfW = w * 0.5;
      const halfT = (thicknessParam != null ? thicknessParam : w * 0.15) * 0.5;
      const b = new THREE.Vector3().crossVectors(t, n).normalize();
      const v0 = new THREE.Vector3().copy(p).addScaledVector(n, halfW).addScaledVector(b, halfT);
      const v1 = new THREE.Vector3().copy(p).addScaledVector(n, -halfW).addScaledVector(b, halfT);
      const v2 = new THREE.Vector3().copy(p).addScaledVector(n, -halfW).addScaledVector(b, -halfT);
      const v3 = new THREE.Vector3().copy(p).addScaledVector(n, halfW).addScaledVector(b, -halfT);
      verts.push(
        v0.x, v0.y, v0.z,
        v1.x, v1.y, v1.z,
        v2.x, v2.y, v2.z,
        v3.x, v3.y, v3.z,
      );
    }

    // Connect rings
    for (let i = 0; i < segs; i++) {
      const r0 = i * 4;
      const r1 = (i + 1) * 4;
      // Top (+b): v0-v1 (r0) to v0-v1 (r1)
      indices.push(r0 + 0, r1 + 0, r0 + 1, r1 + 0, r1 + 1, r0 + 1);
      // Bottom (-b): v3-v2
      indices.push(r0 + 3, r0 + 2, r1 + 3, r1 + 3, r0 + 2, r1 + 2);
      // Side A (+n): v0-v3
      indices.push(r0 + 0, r0 + 3, r1 + 0, r1 + 0, r0 + 3, r1 + 3);
      // Side B (-n): v1-v2
      indices.push(r0 + 1, r1 + 1, r0 + 2, r1 + 1, r1 + 2, r0 + 2);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    // Determine chain for this segment
    const firstResidue = resLocal[0] ?? -1;
    const chainIdx = firstResidue >= 0 ? residueToChain[firstResidue] : -1;
    const hex = palette[(chainIdx >= 0 ? chainIdx : 0) % palette.length];
    const mat: THREE.Material = materialKind === "basic"
      ? new THREE.MeshBasicMaterial({ color: hex, side: doubleSided ? THREE.DoubleSide : THREE.FrontSide })
      : materialKind === "lambert"
      ? new THREE.MeshLambertMaterial({ color: hex, side: doubleSided ? THREE.DoubleSide : THREE.FrontSide })
      : new THREE.MeshStandardMaterial({ color: hex, metalness: 0.1, roughness: 0.68, side: doubleSided ? THREE.DoubleSide : THREE.FrontSide });

    const mesh = new THREE.Mesh(geom, mat);
    group.add(mesh);
  }

  return group;
}
