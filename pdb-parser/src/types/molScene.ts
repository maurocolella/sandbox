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
    residues?: { name: string; seq: number; iCode?: string }[];
    chainSegments?: { chain: number; startResidue: number; endResidue: number }[];
    secondary?: { kind: "helix" | "sheet"; chain: number; startResidue: number; endResidue: number }[];
  };
  bbox?: { min: [number, number, number]; max: [number, number, number] };
  metadata?: {
    pdbId?: string;
    modelCount?: number;
    warnings?: string[];
  };
}
