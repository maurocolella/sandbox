/*
 Title: useFilteredScene
 Description: Derives a filtered MolScene based on selected chain indices without relying on parser helpers.
 Returns the filtered scene and a selectionKey for memoization and render key derivation.
*/
import { useMemo } from "react";
import type { MolScene } from "pdb-parser";

export function useFilteredScene(scene: MolScene | null, selectedChainIndices: number[]): { filtered: MolScene | null; selectionKey: string } {
  const selectionKey = useMemo(() => selectedChainIndices.join("-"), [selectedChainIndices]);

  const filtered = useMemo<MolScene | null>(() => {
    if (!scene) return null;
    const chains = scene.tables?.chains ?? [];
    // If scene has no chains metadata, return as-is
    if (chains.length === 0) return scene;
    // If selection covers all chains, return as-is
    if (selectedChainIndices.length === chains.length) return scene;
    // If selection is empty, return an empty scene
    const selected = new Set<number>(selectedChainIndices);
    const hasSelection = selected.size > 0;
    if (!hasSelection) {
      return {
        atoms: { count: 0, positions: new Float32Array(0), radii: new Float32Array(0) },
        bonds: { count: 0, indexA: new Uint32Array(0), indexB: new Uint32Array(0) },
        backbone: undefined,
        tables: scene.tables,
        index: undefined,
        bbox: undefined,
        metadata: scene.metadata,
      } as MolScene;
    }

    // Require chainIndex on atoms to subset; otherwise return as-is
    const atomCount = scene.atoms?.count ?? 0;
    const chainIndex = scene.atoms.chainIndex;
    if (!chainIndex || atomCount === 0) return scene;

    // Build atom mapping old->new for selected chains
    const oldToNew = new Int32Array(atomCount).fill(-1);
    const keptAtoms: number[] = [];
    for (let i = 0; i < atomCount; i++) {
      const ci = chainIndex[i]!;
      if (selected.has(ci)) {
        oldToNew[i] = keptAtoms.length;
        keptAtoms.push(i);
      }
    }

    // Atoms: copy selected
    const newAtomCount = keptAtoms.length;
    const newPositions = new Float32Array(newAtomCount * 3);
    const newRadii = new Float32Array(newAtomCount);
    const hasColors = !!scene.atoms.colors;
    const newColors = hasColors ? new Uint8Array(newAtomCount * 3) : undefined;
    const hasElement = !!scene.atoms.element;
    const newElement = hasElement ? new Uint16Array(newAtomCount) : undefined;
    const hasSerial = !!scene.atoms.serial;
    const newSerial = hasSerial ? new Uint32Array(newAtomCount) : undefined;
    const hasNames = Array.isArray(scene.atoms.names);
    const newNames = hasNames ? new Array<string>(newAtomCount) : undefined;
    const hasResidueIndex = !!scene.atoms.residueIndex;
    const newResidueIndex = hasResidueIndex ? new Uint32Array(newAtomCount) : undefined;
    const newChainIndex = new Uint32Array(newAtomCount);

    for (let ni = 0; ni < newAtomCount; ni++) {
      const oi = keptAtoms[ni]!;
      newPositions[ni * 3] = scene.atoms.positions[oi * 3]!;
      newPositions[ni * 3 + 1] = scene.atoms.positions[oi * 3 + 1]!;
      newPositions[ni * 3 + 2] = scene.atoms.positions[oi * 3 + 2]!;
      newRadii[ni] = scene.atoms.radii[oi]!;
      if (newColors) {
        newColors[ni * 3] = scene.atoms.colors![oi * 3]!;
        newColors[ni * 3 + 1] = scene.atoms.colors![oi * 3 + 1]!;
        newColors[ni * 3 + 2] = scene.atoms.colors![oi * 3 + 2]!;
      }
      if (newElement) newElement[ni] = scene.atoms.element![oi]!;
      if (newSerial) newSerial[ni] = scene.atoms.serial![oi]!;
      if (newNames) newNames[ni] = scene.atoms.names![oi]!;
      if (newResidueIndex) newResidueIndex[ni] = scene.atoms.residueIndex![oi]!;
      newChainIndex[ni] = chainIndex[oi]! as unknown as number;
    }

    // Bonds: keep only those whose endpoints are kept, and remap indices
    let newBonds: MolScene["bonds"] | undefined = undefined;
    if (scene.bonds && scene.bonds.count > 0) {
      const idxA = scene.bonds.indexA;
      const idxB = scene.bonds.indexB;
      const keptA: number[] = [];
      const keptB: number[] = [];
      for (let i = 0; i < scene.bonds.count; i++) {
        const oa = idxA[i]!;
        const ob = idxB[i]!;
        const na = oldToNew[oa]!;
        const nb = oldToNew[ob]!;
        if (na >= 0 && nb >= 0) {
          keptA.push(na);
          keptB.push(nb);
        }
      }
      newBonds = {
        count: keptA.length,
        indexA: Uint32Array.from(keptA),
        indexB: Uint32Array.from(keptB),
        order: scene.bonds.order ? Uint8Array.from(keptA.map((_, i) => scene.bonds!.order![i]!)) : undefined,
      };
    }

    // Residue -> chain map (prefer explicit chain on residues; fallback using first atom)
    const residues = scene.tables?.residues ?? [];
    const residueCount = residues.length;
    const residueToChain = new Int32Array(Math.max(1, residueCount)).fill(-1);
    let hasExplicit = false;
    for (let r = 0; r < residueCount; r++) {
      const c = (residues[r] as { chain?: number } | undefined)?.chain;
      if (typeof c === "number" && c >= 0) { residueToChain[r] = c; hasExplicit = true; }
    }
    if (!hasExplicit && scene.atoms.residueIndex && chainIndex) {
      for (let ai = 0; ai < atomCount; ai++) {
        const ri = scene.atoms.residueIndex![ai]!;
        if (ri >= 0 && ri < residueToChain.length && residueToChain[ri] === -1) residueToChain[ri] = chainIndex[ai]!;
      }
    }

    // Backbone: filter by residue chain selection
    let newBackbone: MolScene["backbone"] | undefined = undefined;
    if (scene.backbone) {
      const srcPos = scene.backbone.positions;
      const srcSeg = scene.backbone.segments;
      const srcRes = scene.backbone.residueOfPoint;
      const posOut: number[] = [];
      const segOut: number[] = [];
      const resOut: number[] = [];
      let writeBase = 0;
      for (let s = 0; s < srcSeg.length; s += 2) {
        const start = srcSeg[s]!;
        const end = srcSeg[s + 1]!;
        let kept = 0;
        const base = writeBase;
        for (let i = start; i < end; i++) {
          const ri = srcRes ? srcRes[i]! : -1;
          const rc = ri >= 0 ? residueToChain[ri]! : -1;
          if (rc >= 0 && selected.has(rc)) {
            posOut.push(srcPos[i * 3]!, srcPos[i * 3 + 1]!, srcPos[i * 3 + 2]!);
            if (srcRes) resOut.push(ri);
            kept++;
          }
        }
        if (kept >= 2) {
          segOut.push(base, base + kept);
          writeBase += kept;
        } else {
          // rollback partial writes if fewer than 2 kept
          posOut.length = base * 3;
          if (srcRes) resOut.length = base;
        }
      }
      if (writeBase > 0) {
        newBackbone = {
          positions: Float32Array.from(posOut),
          segments: Uint32Array.from(segOut),
          residueOfPoint: scene.backbone.residueOfPoint && resOut.length > 0 ? Uint32Array.from(resOut) : undefined,
        };
      }
    }

    // Recompute bbox from filtered atoms
    let bbox: MolScene["bbox"] | undefined = undefined;
    if (newAtomCount > 0) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < newAtomCount; i++) {
        const x = newPositions[i * 3]!, y = newPositions[i * 3 + 1]!, z = newPositions[i * 3 + 2]!;
        if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
      }
      bbox = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } as MolScene["bbox"];
    }

    const filteredScene: MolScene = {
      atoms: {
        count: newAtomCount,
        positions: newPositions,
        radii: newRadii,
        colors: newColors,
        element: newElement,
        serial: newSerial,
        names: newNames,
        chainIndex: newChainIndex,
        residueIndex: newResidueIndex,
      },
      bonds: newBonds,
      backbone: newBackbone,
      tables: scene.tables,
      index: undefined,
      bbox,
      metadata: scene.metadata,
    };

    return filteredScene;
  }, [scene, selectedChainIndices]);

  return { filtered, selectionKey };
}
