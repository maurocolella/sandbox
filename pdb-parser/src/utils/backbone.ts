/**
 * Backbone trace shared by the PDB and mmCIF loaders: one point per residue (protein CA, else nucleic P),
 * with the CA->O (carbonyl) unit vector that orients cartoons, split into segments at chain breaks.
 * Residues without a CA/P trace atom (waters, ligands) are skipped.
 */

export interface BackboneTrace {
  positions: Float32Array;
  segments: Uint32Array;
  residueOfPoint: Uint32Array;
  orientation: Float32Array;
}

export interface BackboneTraceInput {
  names: string[]; // per atom
  elementCodes: Uint16Array; // per atom (atomic number)
  positions: Float32Array; // per atom xyz
  residueIndex: Uint32Array; // per atom
  residueCount: number;
  /** Residue ranges to trace (inclusive), e.g. one per polymer chain. */
  segments: { startResidue: number; endResidue: number }[];
}

const CARBON = 6, PHOSPHORUS = 15;
// Consecutive trace atoms farther apart than this are a chain break (missing residues)
const CA_GAP_SQ = 4.5 * 4.5;
const P_GAP_SQ = 8.0 * 8.0;

export function buildBackboneTrace(input: BackboneTraceInput): BackboneTrace | undefined {
  const { names, elementCodes, positions, residueIndex, residueCount } = input;
  const traceAtom = new Int32Array(residueCount).fill(-1);
  const traceIsCA = new Uint8Array(residueCount);
  const oxygenAtom = new Int32Array(residueCount).fill(-1);
  for (let i = 0; i < names.length; i++) {
    const ri = residueIndex[i]!;
    const an = names[i]!;
    if (an === "CA" && elementCodes[i] === CARBON) {
      if (!traceIsCA[ri]) { traceAtom[ri] = i; traceIsCA[ri] = 1; }
    } else if (an === "P" && elementCodes[i] === PHOSPHORUS) {
      if (traceAtom[ri]! < 0) traceAtom[ri] = i;
    } else if (an === "O" && oxygenAtom[ri]! < 0) {
      oxygenAtom[ri] = i;
    }
  }

  const pts: number[] = [];
  const ori: number[] = [];
  const resOfPt: number[] = [];
  const segIndices: number[] = [];
  let runStart = 0;
  // Close the current run; runs shorter than 2 points are dropped
  const closeRun = () => {
    const runEnd = pts.length / 3;
    if (runEnd - runStart >= 2) segIndices.push(runStart, runEnd);
    else { pts.length = runStart * 3; ori.length = runStart * 3; resOfPt.length = runStart; }
    runStart = pts.length / 3;
  };
  for (const seg of input.segments) {
    let prevAtom = -1;
    for (let ri = seg.startResidue; ri <= seg.endResidue; ri++) {
      const ai = traceAtom[ri]!;
      if (ai < 0) continue;
      const x = positions[ai * 3]!, y = positions[ai * 3 + 1]!, z = positions[ai * 3 + 2]!;
      if (prevAtom >= 0) {
        const dx = x - positions[prevAtom * 3]!, dy = y - positions[prevAtom * 3 + 1]!, dz = z - positions[prevAtom * 3 + 2]!;
        if (dx * dx + dy * dy + dz * dz > (traceIsCA[ri] ? CA_GAP_SQ : P_GAP_SQ)) closeRun();
      }
      pts.push(x, y, z);
      resOfPt.push(ri);
      const oi = oxygenAtom[ri]!;
      if (traceIsCA[ri] && oi >= 0) {
        const ox = positions[oi * 3]! - x, oy = positions[oi * 3 + 1]! - y, oz = positions[oi * 3 + 2]! - z;
        const len = Math.hypot(ox, oy, oz) || 1;
        ori.push(ox / len, oy / len, oz / len);
      } else {
        ori.push(0, 0, 0);
      }
      prevAtom = ai;
    }
    closeRun();
  }

  if (pts.length < 6 || segIndices.length === 0) return undefined;
  return {
    positions: new Float32Array(pts),
    segments: new Uint32Array(segIndices),
    residueOfPoint: new Uint32Array(resOfPt),
    orientation: new Float32Array(ori),
  };
}
