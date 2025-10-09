import type { MolScene } from "../types/molScene.js";

function buildChainIdMap(chains: { id: string }[] | undefined): Record<string, number> {
  if (!chains || chains.length === 0) return {};
  const out: Record<string, number> = {};
  for (let i = 0; i < chains.length; i++) out[chains[i]!.id] = i;
  return out;
}

function ensureResidueToChain(scene: MolScene): Int32Array {
  const residues = scene.tables?.residues ?? [];
  const residueCount = residues.length;
  const out = new Int32Array(Math.max(1, residueCount)).fill(-1);
  if (residueCount === 0) return out;

  // Prefer explicit chain on residues if present
  let hasAny = false;
  for (let i = 0; i < residueCount; i++) {
    const c = residues[i]!.chain;
    if (typeof c === "number" && c >= 0) {
      out[i] = c;
      hasAny = true;
    }
  }
  if (hasAny) return out;

  // Fallback: derive from the first atom in each residue
  const aCount = scene.atoms.count;
  const atomRes = scene.atoms.residueIndex;
  const atomChain = scene.atoms.chainIndex;
  if (!atomRes || !atomChain) return out;
  for (let ai = 0; ai < aCount; ai++) {
    const ri = atomRes[ai]!;
    if (ri >= 0 && ri < out.length && out[ri] === -1) out[ri] = atomChain[ai]!;
  }
  return out;
}

function buildResidueKeyMap(scene: MolScene, residueToChain: Int32Array): Record<string, number> {
  const residues = scene.tables?.residues ?? [];
  const chains = scene.tables?.chains ?? [];
  const out: Record<string, number> = {};
  for (let ri = 0; ri < residues.length; ri++) {
    const r = residues[ri]!;
    const ci = residueToChain[ri]!;
    const chainId = ci >= 0 && ci < chains.length ? chains[ci]!.id : " ";
    const key = `${chainId}|${r.seq}|${r.iCode || ""}|${r.name}`;
    out[key] = ri;
  }
  return out;
}

export function buildSceneIndex(scene: MolScene): NonNullable<MolScene["index"]> {
  const chains = scene.tables?.chains ?? [];
  const residues = scene.tables?.residues ?? [];
  const aCount = scene.atoms.count;
  const cCount = chains.length;
  const rCount = residues.length;

  const residueToChain = ensureResidueToChain(scene);

  // chain -> residues (CSR)
  const chainResidueCounts = new Uint32Array(Math.max(1, cCount));
  for (let ri = 0; ri < rCount; ri++) {
    const ci = residueToChain[ri]!;
    if (ci >= 0 && ci < cCount) chainResidueCounts[ci]++;
  }
  const chainResidueOffsets = new Uint32Array(Math.max(1, cCount + 1));
  for (let i = 0; i < cCount; i++) chainResidueOffsets[i + 1] = chainResidueOffsets[i]! + chainResidueCounts[i]!;
  const chainResidueIndex = new Uint32Array(Math.max(0, rCount));
  const crWrite = chainResidueOffsets.slice();
  for (let ri = 0; ri < rCount; ri++) {
    const ci = residueToChain[ri]!;
    if (ci >= 0 && ci < cCount) chainResidueIndex[crWrite[ci]++] = ri >>> 0;
  }

  // residue -> atoms (CSR)
  const residueAtomCounts = new Uint32Array(Math.max(1, rCount));
  if (scene.atoms.residueIndex) {
    for (let ai = 0; ai < aCount; ai++) {
      const ri = scene.atoms.residueIndex[ai]!;
      if (ri >= 0 && ri < rCount) residueAtomCounts[ri]++;
    }
  }
  const residueAtomOffsets = new Uint32Array(Math.max(1, rCount + 1));
  for (let i = 0; i < rCount; i++) residueAtomOffsets[i + 1] = residueAtomOffsets[i]! + residueAtomCounts[i]!;
  const residueAtomIndex = new Uint32Array(Math.max(0, aCount));
  const raWrite = residueAtomOffsets.slice();
  if (scene.atoms.residueIndex) {
    for (let ai = 0; ai < aCount; ai++) {
      const ri = scene.atoms.residueIndex[ai]!;
      if (ri >= 0 && ri < rCount) residueAtomIndex[raWrite[ri]++] = ai >>> 0;
    }
  }

  // chain -> atoms (CSR)
  const chainAtomCounts = new Uint32Array(Math.max(1, cCount));
  if (scene.atoms.chainIndex) {
    for (let ai = 0; ai < aCount; ai++) {
      const ci = scene.atoms.chainIndex[ai]!;
      if (ci >= 0 && ci < cCount) chainAtomCounts[ci]++;
    }
  }
  const chainAtomOffsets = new Uint32Array(Math.max(1, cCount + 1));
  for (let i = 0; i < cCount; i++) chainAtomOffsets[i + 1] = chainAtomOffsets[i]! + chainAtomCounts[i]!;
  const chainAtomIndex = new Uint32Array(Math.max(0, aCount));
  const caWrite = chainAtomOffsets.slice();
  if (scene.atoms.chainIndex) {
    for (let ai = 0; ai < aCount; ai++) {
      const ci = scene.atoms.chainIndex[ai]!;
      if (ci >= 0 && ci < cCount) chainAtomIndex[caWrite[ci]++] = ai >>> 0;
    }
  }

  const chainIdToIndex = buildChainIdMap(scene.tables?.chains);
  const residueKeyToIndex = buildResidueKeyMap(scene, residueToChain);

  return {
    chainResidueOffsets,
    chainResidueIndex,
    residueAtomOffsets,
    residueAtomIndex,
    chainAtomOffsets,
    chainAtomIndex,
    chainIdToIndex,
    residueKeyToIndex,
  };
}
