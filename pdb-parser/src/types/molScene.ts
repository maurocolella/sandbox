export interface MolScene {
  atoms: {
    count: number;
    positions: Float32Array; // length = count * 3
    radii: Float32Array; // length = count
    colors?: Uint8Array; // length = count * 3 (RGB, 0-255)
    element?: Uint16Array; // atomic number or element code; 0 if unknown
    chainIndex?: Uint32Array; // maps atom -> chain table index
    residueIndex?: Uint32Array; // maps atom -> residue table index
    serial?: Uint32Array; // original PDB atom serial numbers
    names?: string[]; // atom names (e.g., CA, N, O, P)
  };
  bonds?: {
    count: number;
    indexA: Uint32Array;
    indexB: Uint32Array;
    order?: Uint8Array; // 1=single, 2=double, ...
  };
  backbone?: {
    positions: Float32Array; // concatenated polyline points
    segments: Uint32Array;   // pairs [startIndex, endIndexExclusive] per segment
    residueOfPoint?: Uint32Array; // per polyline point, the residue index used to place it
  };
  tables?: {
    chains?: { id: string }[];
    residues?: { name: string; seq: number; iCode?: string; chain?: number }[];
    chainSegments?: { chain: number; startResidue: number; endResidue: number }[];
    secondary?: { kind: "helix" | "sheet"; chain: number; startResidue: number; endResidue: number }[];
  };
  /** Fast lookup indices for chains, residues, and atoms. */
  index?: {
    /** CSR-like layout: per-chain list of residue indices. */
    chainResidueOffsets: Uint32Array; // length = chains + 1
    chainResidueIndex: Uint32Array;   // length = residues
    /** CSR-like layout: per-residue list of atom indices. */
    residueAtomOffsets: Uint32Array;  // length = residues + 1
    residueAtomIndex: Uint32Array;    // length = atoms
    /** CSR-like layout: per-chain list of atom indices. */
    chainAtomOffsets: Uint32Array;    // length = chains + 1
    chainAtomIndex: Uint32Array;      // length = atoms
    /** String id -> chain index */
    chainIdToIndex: Record<string, number>;
    /** "chainID|seq|iCode|resName" -> residue index */
    residueKeyToIndex: Record<string, number>;
  };
  bbox?: { min: [number, number, number]; max: [number, number, number] };
  metadata?: {
    pdbId?: string;
    modelCount?: number;
    warnings?: string[];
  };
}

