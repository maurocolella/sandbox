import type { MolScene } from "../types/molScene.js";
import { WarningCollector } from "../utils/warnings.js";
import { elementCodeFromSymbol, elementColorRGB, inferElementSymbol, vdwRadius, covalentRadius } from "../utils/elements.js";
import { buildSceneIndex } from "../utils/buildIndex.js";

interface AtomRecord {
  serial: number;
  name: string;
  altLoc: string;
  resName: string;
  chainID: string;
  resSeq: number;
  iCode: string;
  x: number;
  y: number;
  z: number;
  occupancy: number | null;
  tempFactor: number | null;
  element: string; // normalized symbol
}

async function constructBondsParallel(
  conectPairs: Map<string, number>,
  atomSerialsSeen: Set<number>,
  finalAtoms: AtomRecord[],
  bondPolicy: ParseOptions["bondPolicy"],
  positions: Float32Array,
  W: WarningCollector
): Promise<MolScene["bonds"] | undefined> {
  const count = finalAtoms.length;
  const serialToIndex = new Map<number, number>();
  for (let i = 0; i < count; i++) serialToIndex.set(finalAtoms[i]!.serial, i);

  const bondPairs: Array<[number, number, number]> = [];
  const bondSet = new Set<string>();
  for (const [k, orderCount] of conectPairs) {
    const [sa, sb] = k.split("|").map((s) => parseInt(s, 10));
    if (!atomSerialsSeen.has(sa) || !atomSerialsSeen.has(sb)) continue;
    const ia = serialToIndex.get(sa);
    const ib = serialToIndex.get(sb);
    if (ia == null || ib == null) continue;
    const order = Math.max(1, Math.min(3, orderCount));
    const a = Math.min(ia, ib), b = Math.max(ia, ib);
    const key = `${a}|${b}`;
    if (!bondSet.has(key)) { bondSet.add(key); bondPairs.push([a, b, order]); }
  }

  const needHeuristic = bondPolicy === "conect+heuristic" || (bondPolicy === "heuristic-if-missing" && bondPairs.length === 0);
  if (needHeuristic && count > 1) {
    const slack = 0.45;
    const minDist2 = 0.4 * 0.4;
    const cell = 2.5;
    const cellCounts = new Map<string, number>();
    const covR = new Float32Array(count);
    for (let i = 0; i < count; i++) covR[i] = covalentRadius(finalAtoms[i]!.element);
    for (let i = 0; i < count; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      const k = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
      cellCounts.set(k, (cellCounts.get(k) ?? 0) + 1);
    }
    const cellKeys = Array.from(cellCounts.keys());
    const K = cellKeys.length;
    const offsets = new Uint32Array(K + 1);
    for (let i = 0; i < K; i++) offsets[i + 1] = offsets[i] + (cellCounts.get(cellKeys[i]!)!);
    const members = new Uint32Array(offsets[K]);
    const cursor = new Uint32Array(K);
    const keyToSlot = new Map<string, number>();
    for (let i = 0; i < K; i++) keyToSlot.set(cellKeys[i]!, i);
    for (let i = 0; i < count; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      const k = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
      const s = keyToSlot.get(k)!;
      const dst = offsets[s]! + (cursor[s]++);
      members[dst] = i >>> 0;
    }

    const WorkerAvail = typeof globalThis !== "undefined" && (globalThis as any).Worker;
    const cores: number | undefined = typeof navigator !== "undefined" ? (navigator as any).hardwareConcurrency : undefined;
    const canUseWorkers = Boolean(WorkerAvail && cores && cores > 1 && typeof window !== "undefined");
    const crossIso: boolean = typeof crossOriginIsolated === "boolean" ? (crossOriginIsolated as boolean) : false;

    if (canUseWorkers && (crossIso || K >= 2000)) {
      // Prefer SharedArrayBuffer when cross-origin isolated to avoid copies
      const makeShared = <T extends ArrayBufferView>(src: T): T => {
        if (!crossIso) return src;
        const sab = new SharedArrayBuffer(src.byteLength);
        const ctor = (src as any).constructor as { new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): T };
        const dst = new ctor(sab);
        (dst as any).set(src as any);
        return dst;
      };

      const positionsShared = makeShared(positions);
      const covRShared = makeShared(covR);
      const offsetsShared = makeShared(offsets);
      const membersShared = makeShared(members);

      const workers = Math.max(1, Math.min(K, Math.floor((cores as number) * 0.8)));
      const step = Math.ceil(K / workers);
      const promises: Array<Promise<{ a: Uint32Array; b: Uint32Array; o: Uint8Array }>> = [];
      for (let w = 0; w < workers; w++) {
        const startS = w * step;
        const endS = Math.min(K, startS + step);
        if (startS >= endS) break;
        const url = new URL("./heuristicWorker.js", import.meta.url);
        const worker = new (Worker as any)(url, { type: "module" });
        const p = new Promise<{ a: Uint32Array; b: Uint32Array; o: Uint8Array }>((resolve, reject) => {
          worker.onmessage = (ev: MessageEvent) => { resolve(ev.data as any); worker.terminate(); };
          worker.onerror = (err: unknown) => { reject(err); worker.terminate(); };
        });
        promises.push(p);
        const payload = { positions: positionsShared, covR: covRShared, offsets: offsetsShared, members: membersShared, cellKeys, rangeStart: startS, rangeEnd: endS, slack, minDist2 };
        worker.postMessage(payload);
      }
      const results = await Promise.all(promises);
      for (const { a, b, o } of results) for (let i = 0; i < a.length; i++) bondPairs.push([a[i]!, b[i]!, o[i]!] as [number, number, number]);
      W.add(`Heuristic bonding (parallel) created ${bondPairs.length} total bonds`);
    } else {
      // Fallback to local processing in this thread
      const out: Array<[number, number, number]> = [];
      const processRange = (startS: number, endS: number) => {
        for (let s = startS; s < endS; s++) {
          const key = cellKeys[s]!;
          const [ix, iy, iz] = key.split(",").map((t) => parseInt(t, 10));
          const startA = offsets[s]!;
          const endA = offsets[s + 1]!;
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
            const nk = `${ix + dx},${iy + dy},${iz + dz}`;
            const t = keyToSlot.get(nk);
            if (t == null) continue;
            const startB = offsets[t]!;
            const endB = offsets[t + 1]!;
            for (let ia = startA; ia < endA; ia++) {
              const iA = members[ia]!;
              const xi = positions[iA * 3], yi = positions[iA * 3 + 1], zi = positions[iA * 3 + 2];
              const ri = covR[iA]!;
              const sameCell = s === t;
              const jb = sameCell ? ia + 1 : startB;
              for (let ib = jb; ib < endB; ib++) {
                const iB = members[ib]!;
                const xj = positions[iB * 3], yj = positions[iB * 3 + 1], zj = positions[iB * 3 + 2];
                const dxv = xi - xj, dyv = yi - yj, dzv = zi - zj;
                const d2 = dxv * dxv + dyv * dyv + dzv * dzv;
                if (d2 < minDist2) continue;
                const rj = covR[iB]!;
                const maxD = ri + rj + slack;
                if (d2 <= maxD * maxD) {
                  const a = Math.min(iA, iB), b = Math.max(iA, iB);
                  const key2 = `${a}|${b}`;
                  if (!bondSet.has(key2)) { bondSet.add(key2); out.push([a, b, 1]); }
                }
              }
            }
          }
        }
      };
      processRange(0, K);
      for (let i = 0; i < out.length; i++) bondPairs.push(out[i]!);
      W.add(`Heuristic bonding created ${bondPairs.length} total bonds`);
    }
  }

  if (bondPairs.length === 0) return undefined;
  const bCount = bondPairs.length;
  const indexA = new Uint32Array(bCount);
  const indexB = new Uint32Array(bCount);
  const order = new Uint8Array(bCount);
  for (let i = 0; i < bCount; i++) {
    const [ia, ib, ord] = bondPairs[i]!;
    indexA[i] = ia >>> 0;
    indexB[i] = ib >>> 0;
    order[i] = ord as 1 | 2 | 3 as number;
  }
  return { count: bCount, indexA, indexB, order };
}

export async function parsePdbToMolSceneAsync(pdbText: string, options: ParseOptions = {}): Promise<MolScene> {
  const { altLocPolicy = "occupancy", modelSelection, bondPolicy = "conect+heuristic" } = options;
  const W = new WarningCollector();

  const atoms: AtomRecord[] = [];
  const chainIdToIndex = new Map<string, number>();
  const chains: { id: string }[] = [];
  const residueKeyToIndex = new Map<string, number>();
  const residues: NonNullable<NonNullable<MolScene["tables"]>["residues"]> = [];

  const chainSegments: { chain: number; startResidue: number; endResidue: number }[] = [];
  const segStartByChain = new Map<number, number | null>();
  const lastResidueIdxByChain = new Map<number, number>();
  let lastAtomChainID: string | null = null;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  const conectPairs = new Map<string, number>();
  const atomSerialsSeen = new Set<number>();

  const helixRaw: Array<{ chainID: string; startSeq: number; endSeq: number }> = [];
  const sheetRaw: Array<{ chainID: string; startSeq: number; endSeq: number }> = [];

  let modelCount = 0;
  let currentModel: number | null = null;
  let effectiveModelSelection: number | null | undefined = undefined;
  let seenModelRecords = false;
  let lineNum = 0;

  for (let i = 0, n = pdbText.length; i <= n; ) {
    let j = pdbText.indexOf('\n', i);
    if (j === -1) j = n;
    let line = pdbText.substring(i, j);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    i = j + 1;
    lineNum++;
    if (line.length < 6) continue;
    const rec = slice(line, 0, 6).toUpperCase();
    if (rec.startsWith("MODEL")) {
      seenModelRecords = true;
      modelCount++;
      const m = parseIntSafe(slice(line, 10, 14)) ?? modelCount;
      currentModel = m;
      if (effectiveModelSelection === undefined) {
        effectiveModelSelection = modelSelection == null ? m : modelSelection;
      }
      continue;
    }
    if (rec.startsWith("ENDMDL")) { currentModel = null; continue; }

    if (rec.startsWith("ATOM  ") || rec.startsWith("HETATM")) {
      if (seenModelRecords) {
        const m = currentModel ?? null;
        if (m === null) continue;
        if (effectiveModelSelection != null && m !== effectiveModelSelection) continue;
      }
      const serial = parseIntSafe(slice(line, 6, 11)) ?? 0;
      const name = slice(line, 12, 16);
      const altLoc = slice(line, 16, 17).trim();
      const resName = slice(line, 17, 20).trim();
      const chainIDRaw = slice(line, 21, 22);
      const chainID = chainIDRaw.trim() || " ";
      const resSeq = parseIntSafe(slice(line, 22, 26)) ?? 0;
      const iCode = slice(line, 26, 27).trim();
      const x = parseFloatSafe(slice(line, 30, 38));
      const y = parseFloatSafe(slice(line, 38, 46));
      const z = parseFloatSafe(slice(line, 46, 54));
      const occupancy = parseFloatSafe(slice(line, 54, 60));
      const tempFactor = parseFloatSafe(slice(line, 60, 66));
      const elementField = slice(line, 76, 78);
      const element = inferElementSymbol(elementField, name);
      if (x == null || y == null || z == null) { W.add(`Line ${lineNum}: missing coordinates in ATOM/HETATM`); continue; }
      const atom: AtomRecord = { serial, name, altLoc, resName, chainID, resSeq, iCode, x, y, z, occupancy, tempFactor, element };
      atoms.push(atom);
      atomSerialsSeen.add(serial);
      lastAtomChainID = chainID;
      if (!chainIdToIndex.has(chainID)) { chainIdToIndex.set(chainID, chains.length); chains.push({ id: chainID }); }
      const rKey = `${chainID}|${resSeq}|${iCode || ""}|${resName}`;
      if (!residueKeyToIndex.has(rKey)) {
        residueKeyToIndex.set(rKey, residues.length);
        residues.push({ name: resName, seq: resSeq, iCode: iCode || undefined });
        const ci = chainIdToIndex.get(chainID)!;
        if (!segStartByChain.has(ci) || segStartByChain.get(ci) == null) segStartByChain.set(ci, residues.length - 1);
      }
      { const ci = chainIdToIndex.get(chainID)!; const ri = residueKeyToIndex.get(rKey)!; lastResidueIdxByChain.set(ci, ri); }
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
      continue;
    }

    if (rec.startsWith("HELIX")) {
      const initChain = slice(line, 19, 20).trim() || " ";
      const initSeq = parseIntSafe(slice(line, 21, 26)) ?? 0;
      const endChain = slice(line, 31, 32).trim() || initChain;
      const endSeq = parseIntSafe(slice(line, 33, 38)) ?? initSeq;
      helixRaw.push({ chainID: initChain || endChain, startSeq: initSeq, endSeq });
      continue;
    }

    if (rec.startsWith("SHEET")) {
      const initChain = (slice(line, 21, 22).trim() || slice(line, 20, 21).trim() || " ");
      const initSeq = parseIntSafe(slice(line, 22, 27)) ?? parseIntSafe(slice(line, 21, 26)) ?? 0;
      const endChain = (slice(line, 32, 33).trim() || initChain);
      const endSeq = parseIntSafe(slice(line, 33, 38)) ?? initSeq;
      sheetRaw.push({ chainID: initChain || endChain, startSeq: initSeq, endSeq });
      continue;
    }

    if (rec.startsWith("CONECT")) {
      const a = parseIntSafe(slice(line, 6, 11));
      if (a == null) continue;
      const b1 = parseIntSafe(slice(line, 11, 16));
      const b2 = parseIntSafe(slice(line, 16, 21));
      const b3 = parseIntSafe(slice(line, 21, 26));
      const b4 = parseIntSafe(slice(line, 26, 31));
      const bs = [b1, b2, b3, b4].filter((v): v is number => v != null);
      for (const b of bs) {
        const lo = Math.min(a, b), hi = Math.max(a, b);
        if (lo === 0 || hi === 0 || lo === hi) continue;
        const key = `${lo}|${hi}`;
        conectPairs.set(key, (conectPairs.get(key) ?? 0) + 1);
      }
      continue;
    }

    if (rec.startsWith("TER")) {
      if (seenModelRecords) {
        const m = currentModel ?? null; if (m === null) continue;
        if (effectiveModelSelection != null && m !== effectiveModelSelection) continue;
      }
      const tChain = (slice(line, 21, 22).trim() || lastAtomChainID || " ");
      if (!chainIdToIndex.has(tChain)) continue;
      const ci = chainIdToIndex.get(tChain)!;
      const start = segStartByChain.get(ci);
      const end = lastResidueIdxByChain.get(ci);
      if (start != null && end != null && end >= start) chainSegments.push({ chain: ci, startResidue: start, endResidue: end });
      segStartByChain.set(ci, null);
      continue;
    }
  }

  const finalAtoms: AtomRecord[] = resolveAltLocs(atoms, altLocPolicy, W);
  const { count, positions, radii, colors, elementCodes, chainIndex, residueIndex, serial, names } =
    packAtomArrays(finalAtoms, chainIdToIndex, residueKeyToIndex);

  const bonds = await constructBondsParallel(conectPairs, atomSerialsSeen, finalAtoms, bondPolicy, positions, W);

  const backboneBuilt = buildBackbone(finalAtoms, residueKeyToIndex, chainIdToIndex, chainSegments, positions, residueIndex);

  const residueToChainIndex: number[] = new Array(residues.length).fill(-1);
  for (let ai = 0; ai < count; ai++) { const ri = residueIndex[ai]!; if (residueToChainIndex[ri] === -1) residueToChainIndex[ri] = chainIndex[ai]!; }

  let secondary: MolScene["tables"] extends undefined ? undefined : NonNullable<MolScene["tables"]>["secondary"] = undefined as any;
  if (helixRaw.length || sheetRaw.length) {
    const out: { kind: "helix" | "sheet"; chain: number; startResidue: number; endResidue: number }[] = [];
    for (const h of helixRaw) {
      const ci = chainIdToIndex.get(h.chainID); if (ci == null) continue;
      let startRi: number | null = null; let endRi: number | null = null;
      for (let ri = 0; ri < residues.length; ri++) { const r = residues[ri]!; const rChainIdx = residueToChainIndex[ri]; if (rChainIdx !== ci) continue; if (r.seq >= h.startSeq && startRi == null) startRi = ri; if (r.seq <= h.endSeq) endRi = ri; }
      if (startRi != null && endRi != null && endRi >= startRi) out.push({ kind: "helix", chain: ci, startResidue: startRi, endResidue: endRi });
    }
    for (const s of sheetRaw) {
      const ci = chainIdToIndex.get(s.chainID); if (ci == null) continue;
      let startRi: number | null = null; let endRi: number | null = null;
      for (let ri = 0; ri < residues.length; ri++) { const r = residues[ri]!; const rChainIdx = residueToChainIndex[ri]; if (rChainIdx !== ci) continue; if (r.seq >= s.startSeq && startRi == null) startRi = ri; if (r.seq <= s.endSeq) endRi = ri; }
      if (startRi != null && endRi != null && endRi >= startRi) out.push({ kind: "sheet", chain: ci, startResidue: startRi, endResidue: endRi });
    }
    if (out.length) secondary = out;
  }

  for (let ri = 0; ri < residues.length; ri++) { const ci = residueToChainIndex[ri]!; if (ci != null && ci >= 0) residues[ri]!.chain = ci; }

  const scene: MolScene = {
    atoms: { count, positions, radii, colors, element: elementCodes, chainIndex, residueIndex, serial, names },
    bonds,
    backbone: backboneBuilt && { positions: backboneBuilt.positions, segments: backboneBuilt.segments, residueOfPoint: backboneBuilt.residueOfPoint },
    tables: { chains, residues, chainSegments: chainSegments.length ? chainSegments : undefined, secondary },
    bbox: count > 0 ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } : undefined,
    metadata: { warnings: W.toArray(), modelCount: Math.max(1, modelCount) }
  };

  try { scene.index = buildSceneIndex(scene); } catch {}
  return scene;
}

export interface ParseOptions {
  // When multiple altLocs exist for the same atom site:
  // 'all' => keep all sites as independent atoms; 'occupancy' => keep only the highest-occupancy site
  altLocPolicy?: "all" | "occupancy";
  // Select which MODEL to parse (1-based). If no MODEL records are present, the whole file is considered model 1.
  modelSelection?: number;
  // Bond construction strategy
  // - 'conect-only' (default): only use CONECT records
  // - 'heuristic-if-missing': if no CONECT bonds parsed, build heuristic bonds by distance/covalent radii
  // - 'conect+heuristic': always add heuristic bonds in addition to CONECT (deduped)
  bondPolicy?: "conect-only" | "heuristic-if-missing" | "conect+heuristic";
}

function parseFloatSafe(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

function parseIntSafe(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  // Some files may use non-standard notations; best-effort parse
  const v = parseInt(t, 10);
  return Number.isFinite(v) ? v : null;
}

function slice(line: string, start: number, end: number): string {
  // start and end are 0-based, end-exclusive. Handles short lines gracefully.
  return line.length > start ? line.substring(start, Math.min(end, line.length)) : "";
}

function finalizeOpenChainSegments(
  segStartByChain: Map<number, number | null>,
  lastResidueIdxByChain: Map<number, number>,
  chainSegments: { chain: number; startResidue: number; endResidue: number }[]
) {
  for (const [ci, start] of segStartByChain.entries()) {
    if (start != null) {
      const end = lastResidueIdxByChain.get(ci);
      if (end != null && end >= start) {
        chainSegments.push({ chain: ci, startResidue: start, endResidue: end });
      }
    }
  }
}

function buildBackbone(
  finalAtoms: AtomRecord[],
  residueKeyToIndex: Map<string, number>,
  chainIdToIndex: Map<string, number>,
  chainSegments: { chain: number; startResidue: number; endResidue: number }[],
  positions: Float32Array,
  residueIndex: Uint32Array
): { positions: Float32Array; segments: Uint32Array; residueOfPoint: Uint32Array } | undefined {
  const preferNames = new Set(["CA", "P"]);
  // Map residueIndex -> representative atom index
  const repByResidue = new Map<number, number>();
  for (let i = 0; i < finalAtoms.length; i++) {
    const a = finalAtoms[i]!;
    const rKey = `${a.chainID}|${a.resSeq}|${a.iCode || ""}|${a.resName}`;
    const ri = residueKeyToIndex.get(rKey);
    if (ri == null) continue;
    const an = a.name.trim().toUpperCase();
    const prev = repByResidue.get(ri);
    if (!prev && preferNames.has(an)) {
      repByResidue.set(ri, i);
    } else if (prev == null && an.length > 0) {
      // fallback: take the first encountered atom for that residue if no CA/P
      repByResidue.set(ri, i);
    }
  }

  // If no chain segments detected, create per-chain segments spanning residue index range
  let segments = chainSegments.slice();
  if (segments.length === 0) {
    const minByChain = new Map<number, number>();
    const maxByChain = new Map<number, number>();
    for (const [rKey, ri] of residueKeyToIndex) {
      const chainID = rKey.split("|")[0]!;
      const ci = chainIdToIndex.get(chainID);
      if (ci == null) continue;
      const min = minByChain.get(ci);
      const max = maxByChain.get(ci);
      if (min == null || ri < min) minByChain.set(ci, ri);
      if (max == null || ri > max) maxByChain.set(ci, ri);
    }
    for (const [ci, minRi] of minByChain.entries()) {
      const maxRi = maxByChain.get(ci)!;
      segments.push({ chain: ci, startResidue: minRi, endResidue: maxRi });
    }
  }

  const pts: number[] = [];
  const resOfPt: number[] = [];
  const segIndices: number[] = [];
  for (const seg of segments) {
    const start = seg.startResidue;
    const end = seg.endResidue;
    const segStart = pts.length / 3;
    for (let ri = start; ri <= end; ri++) {
      const ai = repByResidue.get(ri);
      if (ai == null) continue;
      const x = positions[ai * 3];
      const y = positions[ai * 3 + 1];
      const z = positions[ai * 3 + 2];
      pts.push(x, y, z);
      resOfPt.push(ri);
    }
    const segEnd = pts.length / 3;
    if (segEnd - segStart >= 2) {
      segIndices.push(segStart, segEnd);
    }
  }

  if (pts.length < 6 || segIndices.length === 0) return undefined;
  return { positions: new Float32Array(pts), segments: new Uint32Array(segIndices), residueOfPoint: new Uint32Array(resOfPt) };
}

function resolveAltLocs(atoms: AtomRecord[], policy: "all" | "occupancy", W: WarningCollector): AtomRecord[] {
  if (atoms.length === 0 || policy === "all") return atoms;
  const bestByKey = new Map<string, AtomRecord>();
  const occByKey = new Map<string, number>();
  for (const a of atoms) {
    const k = `${a.chainID}|${a.resSeq}|${a.iCode || ""}|${a.resName}|${a.name}`;
    const occ = a.occupancy ?? 1.0;
    const prev = occByKey.get(k);
    if (prev == null || occ > prev) {
      bestByKey.set(k, a);
      occByKey.set(k, occ);
    }
  }
  const out = Array.from(bestByKey.values());
  const dropped = atoms.length - out.length;
  if (dropped > 0) W.add(`AltLoc resolution: kept highest-occupancy sites, dropped ${dropped} atoms`);
  return out;
}

function packAtomArrays(
  finalAtoms: AtomRecord[],
  chainIdToIndex: Map<string, number>,
  residueKeyToIndex: Map<string, number>
) {
  const count = finalAtoms.length;
  const positions = new Float32Array(count * 3);
  const radii = new Float32Array(count);
  const colors = new Uint8Array(count * 3);
  const elementCodes = new Uint16Array(count);
  const chainIndex = new Uint32Array(count);
  const residueIndex = new Uint32Array(count);
  const serial = new Uint32Array(count);
  const names: string[] = new Array(count);

  for (let i = 0; i < count; i++) {
    const a = finalAtoms[i]!;
    positions[i * 3] = a.x;
    positions[i * 3 + 1] = a.y;
    positions[i * 3 + 2] = a.z;

    const sym = a.element;
    const code = elementCodeFromSymbol(sym);
    elementCodes[i] = code;

    const r = vdwRadius(sym);
    radii[i] = r;

    const [cr, cg, cb] = elementColorRGB(sym);
    colors[i * 3] = cr;
    colors[i * 3 + 1] = cg;
    colors[i * 3 + 2] = cb;

    chainIndex[i] = chainIdToIndex.get(a.chainID)!;
    const key = `${a.chainID}|${a.resSeq}|${a.iCode || ""}|${a.resName}`;
    residueIndex[i] = residueKeyToIndex.get(key)!;

    serial[i] = a.serial >>> 0;
    names[i] = a.name.trim();
  }

  return { count, positions, radii, colors, elementCodes, chainIndex, residueIndex, serial, names };
}

function constructBonds(
  conectPairs: Map<string, number>,
  atomSerialsSeen: Set<number>,
  finalAtoms: AtomRecord[],
  bondPolicy: ParseOptions["bondPolicy"],
  positions: Float32Array,
  W: WarningCollector
): MolScene["bonds"] | undefined {
  const count = finalAtoms.length;
  const serialToIndex = new Map<number, number>();
  for (let i = 0; i < count; i++) serialToIndex.set(finalAtoms[i]!.serial, i);

  const bondPairs: Array<[number, number, number]> = [];
  const bondSet = new Set<string>();
  // From CONECT
  for (const [k, orderCount] of conectPairs) {
    const [sa, sb] = k.split("|").map((s) => parseInt(s, 10));
    if (!atomSerialsSeen.has(sa) || !atomSerialsSeen.has(sb)) continue;
    const ia = serialToIndex.get(sa);
    const ib = serialToIndex.get(sb);
    if (ia == null || ib == null) continue;
    const order = Math.max(1, Math.min(3, orderCount));
    const a = Math.min(ia, ib), b = Math.max(ia, ib);
    const key = `${a}|${b}`;
    if (!bondSet.has(key)) {
      bondSet.add(key);
      bondPairs.push([a, b, order]);
    }
  }

  // Heuristic
  const needHeuristic = bondPolicy === "conect+heuristic" || (bondPolicy === "heuristic-if-missing" && bondPairs.length === 0);
  if (needHeuristic && count > 1) {
    const slack = 0.45;
    const minDist2 = 0.4 * 0.4;
    const cell = 2.5;
    const cellCounts = new Map<string, number>();
    const covR = new Float32Array(count);
    for (let i = 0; i < count; i++) covR[i] = covalentRadius(finalAtoms[i]!.element);
    for (let i = 0; i < count; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      const k = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
      cellCounts.set(k, (cellCounts.get(k) ?? 0) + 1);
    }
    const cellKeys = Array.from(cellCounts.keys());
    const K = cellKeys.length;
    const offsets = new Uint32Array(K + 1);
    for (let i = 0; i < K; i++) offsets[i + 1] = offsets[i] + (cellCounts.get(cellKeys[i]!)!);
    const members = new Uint32Array(offsets[K]);
    const cursor = new Uint32Array(K);
    const keyToSlot = new Map<string, number>();
    for (let i = 0; i < K; i++) keyToSlot.set(cellKeys[i]!, i);
    for (let i = 0; i < count; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      const k = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
      const s = keyToSlot.get(k)!;
      const dst = offsets[s]! + (cursor[s]++);
      members[dst] = i >>> 0;
    }
    const processRange = (startS: number, endS: number, out: Array<[number, number, number]>) => {
      for (let s = startS; s < endS; s++) {
        const key = cellKeys[s]!;
        const [ix, iy, iz] = key.split(",").map((t) => parseInt(t, 10));
        const startA = offsets[s]!;
        const endA = offsets[s + 1]!;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          const nk = `${ix + dx},${iy + dy},${iz + dz}`;
          const t = keyToSlot.get(nk);
          if (t == null) continue;
          const startB = offsets[t]!;
          const endB = offsets[t + 1]!;
          for (let ia = startA; ia < endA; ia++) {
            const iA = members[ia]!;
            const xi = positions[iA * 3], yi = positions[iA * 3 + 1], zi = positions[iA * 3 + 2];
            const ri = covR[iA]!;
            const sameCell = s === t;
            const jb = sameCell ? ia + 1 : startB;
            for (let ib = jb; ib < endB; ib++) {
              const iB = members[ib]!;
              const xj = positions[iB * 3], yj = positions[iB * 3 + 1], zj = positions[iB * 3 + 2];
              const dxv = xi - xj, dyv = yi - yj, dzv = zi - zj;
              const d2 = dxv * dxv + dyv * dyv + dzv * dzv;
              if (d2 < minDist2) continue;
              const rj = covR[iB]!;
              const maxD = ri + rj + slack;
              if (d2 <= maxD * maxD) {
                const a = Math.min(iA, iB), b = Math.max(iA, iB);
                const key2 = `${a}|${b}`;
                if (!bondSet.has(key2)) {
                  bondSet.add(key2);
                  out.push([a, b, 1]);
                }
              }
            }
          }
        }
      }
    };

    const nbr: Array<[number, number, number]> = [];
    processRange(0, K, nbr);
    for (let i = 0; i < nbr.length; i++) bondPairs.push(nbr[i]!);
    W.add(`Heuristic bonding created ${bondPairs.length} total bonds`);
  }

  if (bondPairs.length === 0) return undefined;
  const bCount = bondPairs.length;
  const indexA = new Uint32Array(bCount);
  const indexB = new Uint32Array(bCount);
  const order = new Uint8Array(bCount);
  for (let i = 0; i < bCount; i++) {
    const [ia, ib, ord] = bondPairs[i]!;
    indexA[i] = ia >>> 0;
    indexB[i] = ib >>> 0;
    order[i] = ord as 1 | 2 | 3 as number;
  }
  return { count: bCount, indexA, indexB, order };
}

export function parsePdbToMolScene(pdbText: string, options: ParseOptions = {}): MolScene {
  const { altLocPolicy = "occupancy", modelSelection, bondPolicy = "conect+heuristic" } = options;
  const W = new WarningCollector();

  const atoms: AtomRecord[] = [];
  const chainIdToIndex = new Map<string, number>();
  const chains: { id: string }[] = [];
  const residueKeyToIndex = new Map<string, number>();
  const residues: NonNullable<NonNullable<MolScene["tables"]>["residues"]> = [];

  // Chain segmentation via TER records (per chain index)
  const chainSegments: { chain: number; startResidue: number; endResidue: number }[] = [];
  const segStartByChain = new Map<number, number | null>();
  const lastResidueIdxByChain = new Map<number, number>();
  let lastAtomChainID: string | null = null;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  // For bonds from CONECT
  const conectPairs = new Map<string, number>(); // key: aSerial|bSerial (a<b), value: count occurrences (approx order)
  const atomSerialsSeen = new Set<number>();

  // Secondary structure (HELIX/SHEET) raw collection (chainID + seq ranges)
  const helixRaw: Array<{ chainID: string; startSeq: number; endSeq: number }> = [];
  const sheetRaw: Array<{ chainID: string; startSeq: number; endSeq: number }> = [];

  let modelCount = 0;
  let currentModel: number | null = null;
  let effectiveModelSelection: number | null | undefined = undefined; // undefined until first MODEL seen
  let seenModelRecords = false;
  let lineNum = 0;

  // Single-pass line scanner (avoid split and second pass)
  for (let i = 0, n = pdbText.length; i <= n; ) {
    let j = pdbText.indexOf('\n', i);
    if (j === -1) j = n;
    let line = pdbText.substring(i, j);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    i = j + 1;
    lineNum++;
    if (line.length < 6) continue;
    const rec = slice(line, 0, 6).toUpperCase();
    if (rec.startsWith("MODEL")) {
      seenModelRecords = true;
      modelCount++;
      const m = parseIntSafe(slice(line, 10, 14)) ?? modelCount; // fallback to ordinal order
      currentModel = m;
      if (effectiveModelSelection === undefined) {
        // Decide effective selection on first MODEL encounter
        effectiveModelSelection = modelSelection == null ? m : modelSelection;
      }
      continue;
    }
    if (rec.startsWith("ENDMDL")) {
      currentModel = null;
      continue;
    }

    if (rec.startsWith("ATOM  ") || rec.startsWith("HETATM")) {
      // Filter by selected model if MODEL sections are present
      if (seenModelRecords) {
        const m = currentModel ?? null;
        if (m === null) continue;
        if (effectiveModelSelection != null && m !== effectiveModelSelection) continue;
      }
      const serial = parseIntSafe(slice(line, 6, 11)) ?? 0;
      const name = slice(line, 12, 16);
      const altLoc = slice(line, 16, 17).trim();
      const resName = slice(line, 17, 20).trim();
      const chainIDRaw = slice(line, 21, 22);
      const chainID = chainIDRaw.trim() || " ";
      const resSeq = parseIntSafe(slice(line, 22, 26)) ?? 0;
      const iCode = slice(line, 26, 27).trim();
      const x = parseFloatSafe(slice(line, 30, 38));
      const y = parseFloatSafe(slice(line, 38, 46));
      const z = parseFloatSafe(slice(line, 46, 54));
      const occupancy = parseFloatSafe(slice(line, 54, 60));
      const tempFactor = parseFloatSafe(slice(line, 60, 66));
      const elementField = slice(line, 76, 78);
      const element = inferElementSymbol(elementField, name);

      if (x == null || y == null || z == null) {
        W.add(`Line ${lineNum}: missing coordinates in ATOM/HETATM`);
        continue;
      }

      const atom: AtomRecord = {
        serial, name, altLoc, resName, chainID, resSeq, iCode, x, y, z,
        occupancy, tempFactor, element
      };
      atoms.push(atom);
      atomSerialsSeen.add(serial);

      lastAtomChainID = chainID;

      if (!chainIdToIndex.has(chainID)) {
        chainIdToIndex.set(chainID, chains.length);
        chains.push({ id: chainID });
      }

      const rKey = `${chainID}|${resSeq}|${iCode || ""}|${resName}`;
      if (!residueKeyToIndex.has(rKey)) {
        residueKeyToIndex.set(rKey, residues.length);
        residues.push({ name: resName, seq: resSeq, iCode: iCode || undefined });
        // Open a segment if not already open for this chain
        const ci = chainIdToIndex.get(chainID)!;
        if (!segStartByChain.has(ci) || segStartByChain.get(ci) == null) {
          segStartByChain.set(ci, residues.length - 1);
        }
      }
      // Track last residue index seen for this chain
      {
        const ci = chainIdToIndex.get(chainID)!;
        const ri = residueKeyToIndex.get(rKey)!;
        lastResidueIdxByChain.set(ci, ri);
      }

      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
      continue;
    }

    if (rec.startsWith("HELIX")) {
      // Use conservative slices as per PDB format (1-based columns):
      // initChainID (20), initSeqNum (22-25), endChainID (32), endSeqNum (34-37)
      const initChain = slice(line, 19, 20).trim() || " ";
      const initSeq = parseIntSafe(slice(line, 21, 26)) ?? 0;
      const endChain = slice(line, 31, 32).trim() || initChain;
      const endSeq = parseIntSafe(slice(line, 33, 38)) ?? initSeq;
      helixRaw.push({ chainID: initChain || endChain, startSeq: initSeq, endSeq: endSeq });
      continue;
    }

    if (rec.startsWith("SHEET")) {
      // Conservative slices for SHEET: initChainID (~22), initSeqNum (~23-26), endChainID (~33), endSeqNum (~34-37)
      const initChain = (slice(line, 21, 22).trim() || slice(line, 20, 21).trim() || " ");
      const initSeq = parseIntSafe(slice(line, 22, 27)) ?? parseIntSafe(slice(line, 21, 26)) ?? 0;
      const endChain = (slice(line, 32, 33).trim() || initChain);
      const endSeq = parseIntSafe(slice(line, 33, 38)) ?? initSeq;
      sheetRaw.push({ chainID: initChain || endChain, startSeq: initSeq, endSeq: endSeq });
      continue;
    }

    if (rec.startsWith("CONECT")) {
      // Only consider bonds if the referenced atoms appear in the selected model (we will filter later using atomSerialsSeen)
      const a = parseIntSafe(slice(line, 6, 11));
      if (a == null) continue;
      // Columns 11-31 contain up to four bonded atom serials (5 cols each): 11-16, 16-21, 21-26, 26-31
      const b1 = parseIntSafe(slice(line, 11, 16));
      const b2 = parseIntSafe(slice(line, 16, 21));
      const b3 = parseIntSafe(slice(line, 21, 26));
      const b4 = parseIntSafe(slice(line, 26, 31));
      const bs = [b1, b2, b3, b4].filter((v): v is number => v != null);
      for (const b of bs) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        if (lo === 0 || hi === 0 || lo === hi) continue;
        const key = `${lo}|${hi}`;
        conectPairs.set(key, (conectPairs.get(key) ?? 0) + 1);
      }
    }

    if (rec.startsWith("TER")) {
      // Respect model selection, similar to atoms
      if (seenModelRecords) {
        const m = currentModel ?? null;
        if (m === null) continue;
        if (effectiveModelSelection != null && m !== effectiveModelSelection) continue;
      }
      // Try to get chainID from the TER line; fallback to lastAtomChainID
      const tChain = (slice(line, 21, 22).trim() || lastAtomChainID || " ");
      if (!chainIdToIndex.has(tChain)) continue;
      const ci = chainIdToIndex.get(tChain)!;
      const start = segStartByChain.get(ci);
      const end = lastResidueIdxByChain.get(ci);
      if (start != null && end != null && end >= start) {
        chainSegments.push({ chain: ci, startResidue: start, endResidue: end });
      }
      // Close current segment for this chain; next residue will open a new one
      segStartByChain.set(ci, null);
      continue;
    }
  }

  // Resolve altLocs
  const finalAtoms: AtomRecord[] = resolveAltLocs(atoms, altLocPolicy, W);

  const { count, positions, radii, colors, elementCodes, chainIndex, residueIndex, serial, names } =
    packAtomArrays(finalAtoms, chainIdToIndex, residueKeyToIndex);

  // Build bonds (CONECT and/or heuristic)
  const bonds = constructBonds(conectPairs, atomSerialsSeen, finalAtoms, bondPolicy, positions, W);

  // Backbone polyline from CA/P with segment breaks from TER segmentation
  const backboneBuilt = buildBackbone(finalAtoms, residueKeyToIndex, chainIdToIndex, chainSegments, positions, residueIndex);

  // Build residue -> chainIndex map (first atom seen for that residue)
  const residueToChainIndex: number[] = new Array(residues.length).fill(-1);
  for (let ai = 0; ai < count; ai++) {
    const ri = residueIndex[ai]!
    if (residueToChainIndex[ri] === -1) residueToChainIndex[ri] = chainIndex[ai]!
  }

  // Map HELIX/SHEET raw spans to residue indices
  let secondary: MolScene["tables"] extends undefined ? undefined : NonNullable<MolScene["tables"]>["secondary"] = undefined as any;
  if (helixRaw.length || sheetRaw.length) {
    const out: { kind: "helix" | "sheet"; chain: number; startResidue: number; endResidue: number }[] = [];
    for (const h of helixRaw) {
      const ci = chainIdToIndex.get(h.chainID);
      if (ci == null) continue;
      // Find first and last residue indices in this chain spanning seq numbers
      let startRi: number | null = null;
      let endRi: number | null = null;
      for (let ri = 0; ri < residues.length; ri++) {
        const r = residues[ri]!;
        const rChainIdx = residueToChainIndex[ri];
        if (rChainIdx !== ci) continue;
        if (r.seq >= h.startSeq && startRi == null) startRi = ri;
        if (r.seq <= h.endSeq) endRi = ri;
      }
      if (startRi != null && endRi != null && endRi >= startRi) out.push({ kind: "helix", chain: ci, startResidue: startRi, endResidue: endRi });
    }
    for (const s of sheetRaw) {
      const ci = chainIdToIndex.get(s.chainID);
      if (ci == null) continue;
      let startRi: number | null = null;
      let endRi: number | null = null;
      for (let ri = 0; ri < residues.length; ri++) {
        const r = residues[ri]!;
        const rChainIdx = residueToChainIndex[ri];
        if (rChainIdx !== ci) continue;
        if (r.seq >= s.startSeq && startRi == null) startRi = ri;
        if (r.seq <= s.endSeq) endRi = ri;
      }
      if (startRi != null && endRi != null && endRi >= startRi) out.push({ kind: "sheet", chain: ci, startResidue: startRi, endResidue: endRi });
    }
    if (out.length) secondary = out;
  }

  // Attach chain index to residue table entries
  for (let ri = 0; ri < residues.length; ri++) {
    const ci = residueToChainIndex[ri]!;
    if (ci != null && ci >= 0) residues[ri]!.chain = ci;
  }

  const scene: MolScene = {
    atoms: { count, positions, radii, colors, element: elementCodes, chainIndex, residueIndex, serial, names },
    bonds,
    backbone: backboneBuilt && {
      positions: backboneBuilt.positions,
      segments: backboneBuilt.segments,
      residueOfPoint: backboneBuilt.residueOfPoint,
    },
    tables: { chains, residues, chainSegments: chainSegments.length ? chainSegments : undefined, secondary },
    bbox: count > 0 ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } : undefined,
    metadata: { warnings: W.toArray(), modelCount: Math.max(1, modelCount) }
  };

  // Build fast lookup indices
  try {
    scene.index = buildSceneIndex(scene);
  } catch {
    // leave index undefined if anything goes wrong
  }

  return scene;
}
