export type RGB = [number, number, number];

// Minimal element table for common biochem elements; values are atomic numbers.
const ELEMENT_INDEX: Record<string, number> = {
  H: 1,
  HE: 2,
  LI: 3,
  BE: 4,
  B: 5,
  C: 6,
  N: 7,
  O: 8,
  F: 9,
  NE: 10,
  NA: 11,
  MG: 12,
  AL: 13,
  SI: 14,
  P: 15,
  S: 16,
  CL: 17,
  AR: 18,
  K: 19,
  CA: 20,
  FE: 26,
  CU: 29,
  ZN: 30,
  SE: 34,
  BR: 35,
  I: 53
};

const CODE_TO_SYMBOL: Record<number, string> = Object.fromEntries(
  Object.entries(ELEMENT_INDEX).map(([sym, code]) => [code, sym])
);

// Very lightweight van der Waals radii (Å) defaults for visualization purposes.
const VDW_RADIUS: Record<string, number> = {
  H: 1.2,
  C: 1.7,
  N: 1.55,
  O: 1.52,
  F: 1.47,
  P: 1.8,
  S: 1.8,
  CL: 1.75,
  SE: 1.9,
  BR: 1.85,
  I: 1.98,
  FE: 1.8,
  MG: 1.73,
  NA: 2.27,
  K: 2.75,
  CA: 2.31,
  ZN: 1.39
};

// Approximate single-bond covalent radii (Å) for heuristic bond detection.
// Values are simplified and only aimed at generating plausible bonds.
const COVALENT_RADIUS: Record<string, number> = {
  H: 0.31,
  C: 0.76,
  N: 0.71,
  O: 0.66,
  F: 0.57,
  P: 1.07,
  S: 1.05,
  CL: 1.02,
  SE: 1.20,
  BR: 1.20,
  I: 1.39,
  FE: 1.24,
  MG: 1.30,
  NA: 1.66,
  K: 2.03,
  CA: 1.74,
  ZN: 1.22
};

// CPK-like colors (RGB 0-255) for common elements
const ELEMENT_COLOR: Record<string, RGB> = {
  H: [255, 255, 255],
  C: [144, 144, 144],
  N: [48, 80, 248],
  O: [255, 13, 13],
  F: [144, 224, 80],
  P: [255, 128, 0],
  S: [255, 255, 48],
  CL: [31, 240, 31],
  SE: [255, 161, 0],
  BR: [166, 41, 41],
  I: [148, 0, 148],
  FE: [224, 102, 51],
  MG: [138, 255, 0],
  NA: [171, 92, 242],
  K: [143, 64, 212],
  CA: [61, 255, 0],
  ZN: [125, 128, 176]
};

export function elementCodeFromSymbol(sym: string | undefined): number {
  if (!sym) return 0;
  const s = sym.trim().toUpperCase();
  return ELEMENT_INDEX[s] ?? 0;
}

export function inferElementSymbol(elementField: string | undefined, atomNameField: string | undefined): string {
  // Prefer the explicit element field when present and plausible
  const ef = (elementField || "").trim();
  if (ef.length === 1 || ef.length === 2) return ef.toUpperCase();

  // Fallback: infer from atom name using PDB-ish heuristics.
  const an = (atomNameField || "").trim();
  if (!an) return "C"; // safe default
  // If the first two chars form a known element, use it; else first char.
  const two = an.slice(0, 2).toUpperCase();
  if (ELEMENT_INDEX[two] != null) return two;
  const one = an[0]!.toUpperCase();
  if (ELEMENT_INDEX[one] != null) return one;
  return "C";
}

export function elementColorRGB(symbol: string): RGB {
  const s = symbol.toUpperCase();
  return ELEMENT_COLOR[s] ?? [200, 200, 200];
}

export function vdwRadius(symbol: string): number {
  const s = symbol.toUpperCase();
  return VDW_RADIUS[s] ?? 1.7; // default to carbon-ish
}

export function covalentRadius(symbol: string): number {
  const s = symbol.toUpperCase();
  return COVALENT_RADIUS[s] ?? 0.76; // default to carbon-ish single-bond radius
}

export function elementSymbolFromCode(code: number | undefined): string | undefined {
  if (!code) return undefined;
  return CODE_TO_SYMBOL[code];
}
