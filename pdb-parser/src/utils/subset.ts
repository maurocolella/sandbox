import type { MolScene } from "../types/molScene.js";
import { buildSceneIndex } from "./buildIndex.js";

function remapArray<T>(arr: T[] | undefined, keepMap: Map<number, number>): T[] | undefined {
  if (!arr) return undefined;
  const out: T[] = new Array(keepMap.size);
  for (const [oldIdx, newIdx] of keepMap.entries()) out[newIdx] = arr[oldIdx]!;
  return out;
}

export function subsetMolSceneByChains(scene: MolScene, includeChains: number[]): MolScene {
  const include = new Set<number>(includeChains);
  const chainsOld = scene.tables?.chains ?? [];
  const residuesOld = scene.tables?.residues ?? [];
  const chainCountOld = chainsOld.length;
  const residueCountOld = residuesOld.length;
  const atomCountOld = scene.atoms.count;

  // Build chain old->new map and new chains table
  const chainOldToNew = new Map<number, number>();
  const chainsNew: { id: string }[] = [];
  for (let i = 0; i < chainCountOld; i++) {
    if (include.has(i)) {
      chainOldToNew.set(i, chainsNew.length);
      chainsNew.push({ id: chainsOld[i]!.id });
    }
  }

  // Decide which residues to keep (those whose chain is kept)
  const keepResidue = new Array<boolean>(residueCountOld).fill(false);
  for (let ri = 0; ri < residueCountOld; ri++) {
    const r = residuesOld[ri]!;
    const ci = r.chain ?? -1;
    if (ci >= 0 && include.has(ci)) keepResidue[ri] = true;
  }

  // Residue old->new remap and new residues table (with chain remapped)
  const residueOldToNew = new Map<number, number>();
  const residuesNew: { name: string; seq: number; iCode?: string; chain?: number }[] = [];
  for (let ri = 0; ri < residueCountOld; ri++) {
    if (!keepResidue[ri]) continue;
    const r = residuesOld[ri]!;
    const oldCi = r.chain ?? -1;
    const newCi = oldCi >= 0 ? chainOldToNew.get(oldCi) : undefined;
    residueOldToNew.set(ri, residuesNew.length);
    residuesNew.push({ name: r.name, seq: r.seq, iCode: r.iCode, chain: newCi });
  }

  // Decide which atoms to keep (by chain index)
  const keepAtom = new Array<boolean>(atomCountOld).fill(false);
  const atomChain = scene.atoms.chainIndex;
  const atomResidue = scene.atoms.residueIndex;
  for (let ai = 0; ai < atomCountOld; ai++) {
    const ci = atomChain ? atomChain[ai]! : -1;
    if (ci >= 0 && include.has(ci)) keepAtom[ai] = true;
  }

  // Atom old->new mapping and counts
  const atomOldToNew = new Map<number, number>();
  let atomCountNew = 0;
  for (let ai = 0; ai < atomCountOld; ai++) {
    if (keepAtom[ai]) atomOldToNew.set(ai, atomCountNew++);
  }

  // Build new atom arrays
  const positionsNew = new Float32Array(atomCountNew * 3);
  const radiiNew = new Float32Array(atomCountNew);
  const colorsNew = scene.atoms.colors ? new Uint8Array(atomCountNew * 3) : undefined;
  const elementNew = scene.atoms.element ? new Uint16Array(atomCountNew) : undefined;
  const chainIndexNew = new Uint32Array(atomCountNew);
  const residueIndexNew = new Uint32Array(atomCountNew);
  const serialNew = scene.atoms.serial ? new Uint32Array(atomCountNew) : undefined;
  const namesNew = scene.atoms.names ? new Array<string>(atomCountNew) : undefined;

  let w = 0;
  for (let ai = 0; ai < atomCountOld; ai++) {
    if (!keepAtom[ai]) continue;
    const idx = w++;
    const p = scene.atoms.positions;
    positionsNew[idx * 3] = p[ai * 3];
    positionsNew[idx * 3 + 1] = p[ai * 3 + 1];
    positionsNew[idx * 3 + 2] = p[ai * 3 + 2];
    radiiNew[idx] = scene.atoms.radii[ai]!;
    if (colorsNew && scene.atoms.colors) {
      colorsNew[idx * 3] = scene.atoms.colors[ai * 3]!;
      colorsNew[idx * 3 + 1] = scene.atoms.colors[ai * 3 + 1]!;
      colorsNew[idx * 3 + 2] = scene.atoms.colors[ai * 3 + 2]!;
    }
    if (elementNew && scene.atoms.element) elementNew[idx] = scene.atoms.element[ai]!;
    const oldCi = atomChain ? atomChain[ai]! : -1;
    chainIndexNew[idx] = oldCi >= 0 ? (chainOldToNew.get(oldCi) ?? 0) : 0;
    const oldRi = atomResidue ? atomResidue[ai]! : -1;
    residueIndexNew[idx] = oldRi >= 0 ? (residueOldToNew.get(oldRi) ?? 0) : 0;
    if (serialNew && scene.atoms.serial) serialNew[idx] = scene.atoms.serial[ai]!;
    if (namesNew && scene.atoms.names) namesNew[idx] = scene.atoms.names[ai]!;
  }

  // Bonds subset and remap
  let bondsNew: MolScene["bonds"] | undefined = undefined;
  if (scene.bonds && scene.bonds.count > 0) {
    const pairs: Array<{ a: number; b: number; ord: number }> = [];
    for (let i = 0; i < scene.bonds.count; i++) {
      const oa = scene.bonds.indexA[i]!;
      const ob = scene.bonds.indexB[i]!;
      const na = atomOldToNew.get(oa);
      const nb = atomOldToNew.get(ob);
      if (na == null || nb == null) continue;
      const a = Math.min(na, nb);
      const b = Math.max(na, nb);
      const ord = scene.bonds.order ? scene.bonds.order[i]! : 1;
      pairs.push({ a, b, ord });
    }
    if (pairs.length > 0) {
      const count = pairs.length;
      const indexA = new Uint32Array(count);
      const indexB = new Uint32Array(count);
      const order = scene.bonds.order ? new Uint8Array(count) : undefined;
      for (let i = 0; i < count; i++) {
        indexA[i] = pairs[i]!.a >>> 0;
        indexB[i] = pairs[i]!.b >>> 0;
        if (order) order[i] = pairs[i]!.ord as 1 | 2 | 3 as number;
      }
      bondsNew = { count, indexA, indexB, order };
    }
  }

  // Backbone subset: filter points whose residueOfPoint is kept, rebuild segments as contiguous runs.
  let backboneNew: MolScene["backbone"] | undefined = undefined;
  if (scene.backbone) {
    const posOld = scene.backbone.positions;
    const segOld = scene.backbone.segments;
    const resOfPtOld = scene.backbone.residueOfPoint;
    const pts: number[] = [];
    const resOfPt: number[] = [];
    const seg: number[] = [];

    for (let s = 0; s < segOld.length; s += 2) {
      const start = segOld[s]!;
      const end = segOld[s + 1]!;
      let runStart: number | null = null;
      for (let i = start; i < end; i++) {
        const oldRi = resOfPtOld ? resOfPtOld[i]! : -1;
        const keptRi = oldRi >= 0 ? residueOldToNew.get(oldRi) : undefined;
        if (keptRi != null) {
          if (runStart == null) runStart = pts.length / 3;
          const idx = i * 3;
          pts.push(posOld[idx]!, posOld[idx + 1]!, posOld[idx + 2]!);
          resOfPt.push(keptRi);
        } else if (runStart != null) {
          const runEnd = pts.length / 3;
          if (runEnd - runStart >= 2) { seg.push(runStart, runEnd); }
          runStart = null;
        }
      }
      if (runStart != null) {
        const runEnd = pts.length / 3;
        if (runEnd - runStart >= 2) { seg.push(runStart, runEnd); }
      }
    }
    if (pts.length >= 6 && seg.length > 0) {
      backboneNew = {
        positions: new Float32Array(pts),
        segments: new Uint32Array(seg),
        residueOfPoint: new Uint32Array(resOfPt),
      };
    }
  }

  // Secondary structure subset and remap
  let secondaryNew: NonNullable<NonNullable<MolScene["tables"]>["secondary"]> | undefined = undefined;
  if (scene.tables?.secondary && scene.tables.secondary.length > 0) {
    const spans: { kind: "helix" | "sheet"; chain: number; startResidue: number; endResidue: number }[] = [];
    for (const s of scene.tables.secondary) {
      if (!include.has(s.chain)) continue;
      // find kept residues within [startResidue, endResidue]
      let firstNew: number | null = null;
      let lastNew: number | null = null;
      for (let ri = s.startResidue; ri <= s.endResidue; ri++) {
        const nr = residueOldToNew.get(ri);
        if (nr != null) {
          if (firstNew == null) firstNew = nr;
          lastNew = nr;
        }
      }
      if (firstNew != null && lastNew != null && lastNew >= firstNew) {
        spans.push({ kind: s.kind, chain: chainOldToNew.get(s.chain)!, startResidue: firstNew, endResidue: lastNew });
      }
    }
    if (spans.length > 0) secondaryNew = spans;
  }

  // Build bbox from kept atoms
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < atomCountNew; i++) {
    const x = positionsNew[i * 3]!;
    const y = positionsNew[i * 3 + 1]!;
    const z = positionsNew[i * 3 + 2]!;
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }
  const bboxNew = atomCountNew > 0 ? { min: [minX, minY, minZ] as [number, number, number], max: [maxX, maxY, maxZ] as [number, number, number] } : undefined;

  const sceneNew: MolScene = {
    atoms: {
      count: atomCountNew,
      positions: positionsNew,
      radii: radiiNew,
      colors: colorsNew,
      element: elementNew,
      chainIndex: chainIndexNew,
      residueIndex: residueIndexNew,
      serial: serialNew,
      names: namesNew,
    },
    bonds: bondsNew,
    backbone: backboneNew,
    tables: {
      chains: chainsNew,
      residues: residuesNew,
      chainSegments: undefined, // recomputed indirectly by backbone
      secondary: secondaryNew,
    },
    bbox: bboxNew,
    metadata: scene.metadata,
  };

  // Build fast lookup indices on the subset
  sceneNew.index = buildSceneIndex(sceneNew);
  return sceneNew;
}
