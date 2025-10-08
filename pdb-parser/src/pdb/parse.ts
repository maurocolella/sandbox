import type { MolScene } from "../types/molScene.js";
import { WarningCollector } from "../utils/warnings.js";
import { elementCodeFromSymbol, elementColorRGB, inferElementSymbol, vdwRadius, covalentRadius } from "../utils/elements.js";

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
    const cellMap = new Map<string, number[]>();
    const cellKey = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;

    const atomElem: string[] = new Array(count);
    for (let i = 0; i < count; i++) {
      atomElem[i] = finalAtoms[i]!.element;
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      const key = cellKey(x, y, z);
      let arr = cellMap.get(key);
      if (!arr) { arr = []; cellMap.set(key, arr); }
      arr.push(i);
    }

    const neighborOffsets: [number, number, number][] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) neighborOffsets.push([dx, dy, dz]);

    for (let i = 0; i < count; i++) {
      const xi = positions[i * 3], yi = positions[i * 3 + 1], zi = positions[i * 3 + 2];
      const ki = cellKey(xi, yi, zi);
      const [ix, iy, iz] = ki.split(",").map((s) => parseInt(s, 10));
      for (const [dx, dy, dz] of neighborOffsets) {
        const nk = `${ix + dx},${iy + dy},${iz + dz}`;
        const bucket = cellMap.get(nk);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          const xj = positions[j * 3], yj = positions[j * 3 + 1], zj = positions[j * 3 + 2];
          const dxv = xi - xj, dyv = yi - yj, dzv = zi - zj;
          const d2 = dxv * dxv + dyv * dyv + dzv * dzv;
          if (d2 < minDist2) continue;
          const ri = covalentRadius(atomElem[i]);
          const rj = covalentRadius(atomElem[j]);
          const maxD = ri + rj + slack;
          if (d2 <= maxD * maxD) {
            const a = i, b = j;
            const key = `${a}|${b}`;
            if (!bondSet.has(key)) {
              bondSet.add(key);
              bondPairs.push([a, b, 1]);
            }
          }
        }
      }
    }
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
  const { altLocPolicy = "occupancy", modelSelection = 1, bondPolicy = "conect+heuristic" } = options;
  const W = new WarningCollector();

  const atoms: AtomRecord[] = [];
  const chainIdToIndex = new Map<string, number>();
  const chains: { id: string }[] = [];
  const residueKeyToIndex = new Map<string, number>();
  const residues: { name: string; seq: number; iCode?: string }[] = [];

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
  const lines = pdbText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length < 6) continue;
    const rec = slice(line, 0, 6).toUpperCase();
    if (rec.startsWith("MODEL")) {
      // MODEL serial may be in cols 10-14
      modelCount++;
      const m = parseIntSafe(slice(line, 10, 14)) ?? modelCount; // fallback to ordinal count
      currentModel = m;
      continue;
    }
    if (rec.startsWith("ENDMDL")) {
      currentModel = null;
      continue;
    }

    if (rec.startsWith("ATOM  ") || rec.startsWith("HETATM")) {
      // Filter by selected model if MODEL sections are present
      if (modelCount > 0) {
        const m = currentModel ?? null;
        if (m === null || m !== modelSelection) {
          continue; // skip atoms not in the selected model
        }
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
        W.add(`Line ${i + 1}: missing coordinates in ATOM/HETATM`);
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
      if (modelCount > 0) {
        const m = currentModel ?? null;
        if (m === null || m !== modelSelection) continue;
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

  return scene;
}
