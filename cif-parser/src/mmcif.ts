/**
 * mmCIF -> MolScene (whitepapers/mmcif-parser.md §4): the semantic layer on top of the column layer.
 *
 * - Chains shown are author chains (auth_asym_id, as in PDB files); residues are split on label chain +
 *   sequence number + insertion code, so ligands and waters get their own residues and microheterogeneous
 *   positions stay one residue whose atoms keep their own residue names.
 * - One model (default: the first in the file). AltLocs: "occupancy" keeps, per residue, the conformer with
 *   the highest mean occupancy (never a mix); "all" keeps everything.
 * - Bonds, in precedence order: the file's _chem_comp_bond templates (matched by atom name), a distance
 *   heuristic for residues without a template, polymer links (peptide C-N, nucleic O3'-P) between
 *   consecutive residues of a chain, _struct_conn covalent/disulfide links within the asymmetric unit, and
 *   unannotated ligand links by distance. Atoms of different altlocs never bond; metal coordination is not
 *   drawn as bonds.
 * - Secondary structure from _struct_conf / _struct_sheet_range, resolved by label ids (auth fallback).
 * - Tolerates missing columns: label_* or auth_* alone, no type_symbol (inferred from the atom name), no
 *   model numbers, no occupancies.
 */
import type { MolScene } from "pdb-parser";
import { buildBackboneTrace, buildSceneIndex, covalentRadius, elementCodeFromSymbol, elementColorRGB, inferElementSymbol, vdwRadius } from "pdb-parser";
import { parseCif, Presence, type CifBlock, type CifDocument, type ColumnSpec, type DecodedColumn } from "./document.js";

const WATER = new Set(["HOH", "WAT", "DOD", "H2O"]);
// Metals and metalloids whose contacts are coordination rather than covalent bonds
const METALS = new Set([3, 4, 11, 12, 13, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 55, 56, 57, 58, 59, 60, 62, 63, 64, 65, 66, 67, 68, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 90, 92]);

/**
 * Element from an mmCIF atom name when type_symbol is missing. Unlike PDB files, names carry no column
 * alignment, so "CA" is ambiguous: an atom named like its residue is an ion (CA in CA, ZN in ZN);
 * otherwise use the first letter, skipping leading digits (1HB -> H).
 */
function inferElement(name: string, comp: string): string {
  if (name && name.toUpperCase() === comp.toUpperCase()) return inferElementSymbol(name, name);
  const letters = name.replace(/^[0-9]+/, "");
  return letters ? inferElementSymbol(letters[0], letters) : "C";
}

/** Uniform grid over atom positions for neighbor queries within one cell. */
class AtomGrid {
  private readonly cellStart: Int32Array;
  private readonly cellAtoms: Int32Array;
  private readonly nx: number;
  private readonly ny: number;
  private readonly nz: number;
  private readonly min: [number, number, number];
  constructor(private readonly positions: Float32Array, count: number, private readonly cell: number) {
    let mx = Infinity, my = Infinity, mz = Infinity, Mx = -Infinity, My = -Infinity, Mz = -Infinity;
    for (let i = 0; i < count; i++) {
      const x = positions[i * 3]!, y = positions[i * 3 + 1]!, z = positions[i * 3 + 2]!;
      if (x < mx) mx = x; if (y < my) my = y; if (z < mz) mz = z; if (x > Mx) Mx = x; if (y > My) My = y; if (z > Mz) Mz = z;
    }
    this.min = [mx, my, mz];
    this.nx = Math.max(1, Math.floor((Mx - mx) / cell) + 1);
    this.ny = Math.max(1, Math.floor((My - my) / cell) + 1);
    this.nz = Math.max(1, Math.floor((Mz - mz) / cell) + 1);
    const cells = this.nx * this.ny * this.nz;
    const cellOf = new Int32Array(count);
    this.cellStart = new Int32Array(cells + 1);
    for (let i = 0; i < count; i++) { const c = this.cellIndex(i); cellOf[i] = c; this.cellStart[c + 1]!++; }
    for (let c = 0; c < cells; c++) this.cellStart[c + 1]! += this.cellStart[c]!;
    const fill = this.cellStart.slice(0, cells);
    this.cellAtoms = new Int32Array(count);
    for (let i = 0; i < count; i++) this.cellAtoms[fill[cellOf[i]!]!++] = i;
  }
  private coord(v: number, axis: 0 | 1 | 2, n: number) {
    return Math.min(n - 1, Math.max(0, Math.floor((v - this.min[axis]) / this.cell)));
  }
  private cellIndex(i: number) {
    const p = this.positions;
    return (this.coord(p[i * 3]!, 0, this.nx) * this.ny + this.coord(p[i * 3 + 1]!, 1, this.ny)) * this.nz + this.coord(p[i * 3 + 2]!, 2, this.nz);
  }
  /** Calls fn for every atom in the 27 cells around atom i (including i itself). */
  forNeighbors(i: number, fn: (j: number) => void) {
    const p = this.positions;
    const cx = this.coord(p[i * 3]!, 0, this.nx), cy = this.coord(p[i * 3 + 1]!, 1, this.ny), cz = this.coord(p[i * 3 + 2]!, 2, this.nz);
    for (let x = Math.max(0, cx - 1); x <= Math.min(this.nx - 1, cx + 1); x++)
      for (let y = Math.max(0, cy - 1); y <= Math.min(this.ny - 1, cy + 1); y++)
        for (let z = Math.max(0, cz - 1); z <= Math.min(this.nz - 1, cz + 1); z++) {
          const c = (x * this.ny + y) * this.nz + z;
          for (let k = this.cellStart[c]!; k < this.cellStart[c + 1]!; k++) fn(this.cellAtoms[k]!);
        }
  }
}

export interface MmcifLoadOptions {
  /** pdbx_PDB_model_num to load; default: the first model in the file. */
  modelSelection?: number;
  altLocPolicy?: "occupancy" | "all";
  /** Build bonds (default true). */
  bonds?: boolean;
  /** Data block index (default 0). */
  block?: number;
}

const ATOM_SPEC = {
  x: { field: "Cartn_x", type: "f32" },
  y: { field: "Cartn_y", type: "f32" },
  z: { field: "Cartn_z", type: "f32" },
  occ: { field: "occupancy", type: "f32" },
  id: { field: "id", type: "i32" },
  element: { field: "type_symbol", type: "str" },
  atom: { field: "label_atom_id", type: "str" },
  authAtom: { field: "auth_atom_id", type: "str" },
  comp: { field: "label_comp_id", type: "str" },
  authComp: { field: "auth_comp_id", type: "str" },
  asym: { field: "label_asym_id", type: "str" },
  authAsym: { field: "auth_asym_id", type: "str" },
  seq: { field: "label_seq_id", type: "i32" },
  authSeq: { field: "auth_seq_id", type: "i32" },
  ins: { field: "pdbx_PDB_ins_code", type: "str" },
  alt: { field: "label_alt_id", type: "str" },
  model: { field: "pdbx_PDB_model_num", type: "i32" },
} satisfies Record<string, ColumnSpec>;
type AtomColumns = Partial<Record<keyof typeof ATOM_SPEC, DecodedColumn>>;

/** Loading progress: bytes parsed, atom rows read, then residues bonded. */
export interface MmcifProgress {
  stage: "parse" | "atoms" | "bonds";
  done: number;
  total: number;
}

/** Parse bytes (already decompressed) and load the first block as a MolScene. */
export function loadMmcif(bytes: Uint8Array, options: MmcifLoadOptions = {}, onProgress?: (p: MmcifProgress) => void): MolScene {
  const doc = parseCif(bytes, {
    decode: { atom_site: ATOM_SPEC },
    ...(onProgress ? { onProgress: (done: number, total: number) => onProgress({ stage: "parse", done, total }) } : {}),
  });
  return mmcifToMolScene(doc, options, onProgress);
}

const present = (c: DecodedColumn | undefined, row: number) => !!c && (!c.mask || c.mask[row] === Presence.Present);
/** String column value, or "" when the column is absent or the value is null. */
const strOf = (c: DecodedColumn | undefined, row: number) => (present(c, row) ? c!.dictionary![c!.values[row]!]! : "");
/** Code of a string column (distinct per value, -1 when null or absent). */
const codeOf = (c: DecodedColumn | undefined, row: number) => (present(c, row) ? c!.values[row]! : -1);

export function mmcifToMolScene(doc: CifDocument, options: MmcifLoadOptions = {}, onProgress?: (p: MmcifProgress) => void): MolScene {
  const warnings: string[] = doc.warnings.map((w) => `line ${w.line}: ${w.code}${w.detail ? ` (${w.detail})` : ""}`);
  const block: CifBlock | undefined = doc.blocks[options.block ?? 0];
  const site = block?.category("atom_site");
  const cols: AtomColumns = site ? (site.decoded ?? site.decodeColumns(ATOM_SPEC)) : {};
  const total = site?.rowCount ?? 0;
  if (!block) warnings.push("no data block");
  else if (!site) warnings.push("no _atom_site category (e.g. coarse-grained integrative model)");

  // Column fallbacks for files written by tools that omit one naming system
  const atomCol = cols.atom ?? cols.authAtom;
  const compCol = cols.comp ?? cols.authComp;
  const asymCol = cols.asym ?? cols.authAsym; // residue identity (label chain)
  const chainCol = cols.authAsym ?? cols.asym; // displayed chain
  const seqCol = cols.seq, authSeqCol = cols.authSeq ?? cols.seq;
  if (site && (!cols.x || !cols.y || !cols.z)) warnings.push("_atom_site has no Cartn_x/y/z");

  // --- Model selection -------------------------------------------------------------------------------
  const models = new Set<number>();
  if (cols.model) for (let r = 0; r < total; r++) models.add(cols.model.values[r]!);
  const model = options.modelSelection ?? (total > 0 && cols.model ? cols.model.values[0]! : 0);
  const inModel = (r: number) => !cols.model || cols.model.values[r] === model;

  // --- Residues (contiguous runs within the model) and altloc choice ---------------------------------
  // A residue changes when label chain, sequence number (label, else auth) or insertion code changes.
  const residueStart: number[] = []; // first row of each residue
  const rowResidue = new Int32Array(total).fill(-1);
  const NO_SEQ = -3e9; // no sequence number at all (a sentinel, since NaN never compares equal)
  let prevAsym = -2, prevSeq = -4e9, prevIns = -2;
  for (let r = 0; r < total; r++) {
    if (!inModel(r)) continue;
    const asym = codeOf(asymCol, r);
    // Label numbering for polymers; author numbering (offset, so the two never collide) for the rest
    const seq = present(seqCol, r) ? seqCol!.values[r]! : present(authSeqCol, r) ? -1e9 + authSeqCol!.values[r]! : NO_SEQ;
    const ins = codeOf(cols.ins, r);
    if (asym !== prevAsym || seq !== prevSeq || ins !== prevIns) {
      residueStart.push(r);
      prevAsym = asym; prevSeq = seq; prevIns = ins;
    }
    rowResidue[r] = residueStart.length - 1;
  }

  const keep = new Uint8Array(total);
  const policy = options.altLocPolicy ?? "occupancy";
  {
    // Per residue: rows with a null altloc are always kept; otherwise keep the altloc with the best mean occupancy
    let r = 0;
    while (r < total) {
      if (rowResidue[r]! < 0) { r++; continue; }
      const res = rowResidue[r]!;
      let end = r;
      while (end < total && (rowResidue[end] === res || rowResidue[end] === -1)) end++;
      let chosen = -1;
      if (policy === "occupancy" && cols.alt) {
        const sum = new Map<number, number>(), n = new Map<number, number>();
        for (let i = r; i < end; i++) {
          if (rowResidue[i] !== res) continue;
          const a = codeOf(cols.alt, i);
          if (a < 0) continue;
          const occ = present(cols.occ, i) ? cols.occ!.values[i]! : 1;
          sum.set(a, (sum.get(a) ?? 0) + occ);
          n.set(a, (n.get(a) ?? 0) + 1);
        }
        let best = -Infinity;
        for (const [a, s] of sum) { const mean = s / n.get(a)!; if (mean > best) { best = mean; chosen = a; } }
      }
      for (let i = r; i < end; i++) {
        if (rowResidue[i] !== res) continue;
        const a = codeOf(cols.alt, i);
        keep[i] = policy === "all" || a < 0 || chosen < 0 || a === chosen ? 1 : 0;
      }
      r = end;
    }
  }

  // --- Atoms -----------------------------------------------------------------------------------------
  let count = 0;
  for (let r = 0; r < total; r++) if (keep[r]) count++;
  const positions = new Float32Array(count * 3);
  const radii = new Float32Array(count);
  const colors = new Uint8Array(count * 3);
  const element = new Uint16Array(count);
  const chainIndex = new Uint32Array(count);
  const residueIndex = new Uint32Array(count);
  const serial = new Uint32Array(count);
  const names: string[] = new Array(count);
  const atomComp: string[] = new Array(count);
  const atomAlt = new Int32Array(count); // altloc code per atom, -1 when none

  // Per-dictionary-entry element properties, computed once per distinct element symbol
  const elemCache = new Map<string, { code: number; radius: number; rgb: [number, number, number]; cov: number }>();
  const elementInfo = (symbol: string) => {
    let e = elemCache.get(symbol);
    if (!e) {
      const s = symbol.toUpperCase() === "D" || symbol.toUpperCase() === "T" ? "H" : symbol; // deuterium/tritium
      const rgb = elementColorRGB(s);
      e = { code: elementCodeFromSymbol(s), radius: vdwRadius(s), rgb: [rgb[0], rgb[1], rgb[2]], cov: covalentRadius(s) };
      elemCache.set(symbol, e);
    }
    return e;
  };
  const covByAtom = new Float32Array(count);
  const elemByCode: (ReturnType<typeof elementInfo> | undefined)[] = [];

  const chainIds: string[] = [];
  const chainOf = new Map<string, number>();
  const residues: { name: string; seq: number; iCode?: string; chain?: number }[] = [];
  const residueOfRes = new Int32Array(residueStart.length).fill(-1); // run index -> kept residue index
  const residueAsym: number[] = []; // label chain code per residue
  const residueLabelSeq: number[] = []; // label_seq_id per residue (NaN if none)
  const residueFirstAtom: number[] = [];
  const residueAtomEnd: number[] = [];
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  let ai = 0;
  for (let r = 0; r < total; r++) {
    if (onProgress && (r & 0xffff) === 0) onProgress({ stage: "atoms", done: r, total });
    if (!keep[r]) continue;
    const run = rowResidue[r]!;
    let ri = residueOfRes[run]!;
    if (ri < 0) {
      const chainId = strOf(chainCol, r);
      let ci = chainOf.get(chainId);
      if (ci === undefined) { ci = chainIds.length; chainIds.push(chainId); chainOf.set(chainId, ci); }
      ri = residueOfRes[run] = residues.length;
      const ins = strOf(cols.ins, r);
      const seq = present(authSeqCol, r) ? authSeqCol!.values[r]! : 0;
      residues.push(ins ? { name: strOf(compCol, r), seq, iCode: ins, chain: ci } : { name: strOf(compCol, r), seq, chain: ci });
      residueAsym.push(codeOf(asymCol, r));
      residueLabelSeq.push(present(seqCol, r) ? seqCol!.values[r]! : NaN);
      residueFirstAtom.push(ai);
      residueAtomEnd.push(ai);
    }
    const x = cols.x ? cols.x.values[r]! : 0, y = cols.y ? cols.y.values[r]! : 0, z = cols.z ? cols.z.values[r]! : 0;
    positions[ai * 3] = x; positions[ai * 3 + 1] = y; positions[ai * 3 + 2] = z;
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    const name = strOf(atomCol, r);
    const ec = codeOf(cols.element, r);
    let e = ec >= 0 ? elemByCode[ec] : undefined;
    if (!e) {
      e = elementInfo(strOf(cols.element, r) || inferElement(name, strOf(compCol, r)));
      if (ec >= 0) elemByCode[ec] = e;
    }
    element[ai] = e.code; radii[ai] = e.radius; covByAtom[ai] = e.cov;
    colors[ai * 3] = e.rgb[0]; colors[ai * 3 + 1] = e.rgb[1]; colors[ai * 3 + 2] = e.rgb[2];
    names[ai] = name;
    atomComp[ai] = strOf(compCol, r);
    atomAlt[ai] = codeOf(cols.alt, r);
    serial[ai] = cols.id ? cols.id.values[r]! >>> 0 : ai + 1;
    residueIndex[ai] = ri;
    chainIndex[ai] = residues[ri]!.chain!;
    residueAtomEnd[ri] = ai + 1;
    ai++;
  }

  // --- Polymer segments and backbone -----------------------------------------------------------------
  // Contiguous residues sharing a label chain; the trace skips residues without CA/P.
  const chainSegments: { chain: number; startResidue: number; endResidue: number }[] = [];
  for (let ri = 0; ri < residues.length; ) {
    let end = ri;
    while (end + 1 < residues.length && residueAsym[end + 1] === residueAsym[ri]) end++;
    if (!Number.isNaN(residueLabelSeq[ri]!) || end > ri) chainSegments.push({ chain: residues[ri]!.chain!, startResidue: ri, endResidue: end });
    ri = end + 1;
  }
  const backbone = buildBackboneTrace({ names, elementCodes: element, positions, residueIndex, residueCount: residues.length, segments: chainSegments });

  // --- Residue lookups (for secondary structure and struct_conn) --------------------------------------
  const asymDict = asymCol?.dictionary ?? [];
  const byLabel = new Map<string, number>(); // "labelAsym|labelSeq" -> residue (polymers)
  const byAuth = new Map<string, number>(); // "labelAsym|authSeq|ins" -> residue (all)
  const byAuthChain = new Map<string, number>(); // "authAsym|authSeq|ins" -> residue (all)
  for (let ri = 0; ri < residues.length; ri++) {
    const asym = residueAsym[ri]! >= 0 ? asymDict[residueAsym[ri]!]! : "";
    const res = residues[ri]!;
    if (!Number.isNaN(residueLabelSeq[ri]!)) { const k = `${asym}|${residueLabelSeq[ri]}`; if (!byLabel.has(k)) byLabel.set(k, ri); }
    const ka = `${asym}|${res.seq}|${res.iCode ?? ""}`;
    if (!byAuth.has(ka)) byAuth.set(ka, ri);
    const kc = `${chainIds[res.chain!]}|${res.seq}|${res.iCode ?? ""}`;
    if (!byAuthChain.has(kc)) byAuthChain.set(kc, ri);
  }
  const nullStr = (s: string) => (s === "" || s === "." || s === "?" ? "" : s);
  const fieldStr = (cat: ReturnType<CifBlock["category"]>, name: string, row: number) => {
    const f = cat?.getField(name);
    return f && f.valueKind(row) === Presence.Present ? f.str(row) : "";
  };

  // --- Secondary structure ---------------------------------------------------------------------------
  const secondary: { kind: "helix" | "sheet"; chain: number; startResidue: number; endResidue: number }[] = [];
  const addSpan = (kind: "helix" | "sheet", cat: ReturnType<CifBlock["category"]>, row: number) => {
    const resolve = (side: "beg" | "end") => {
      const asym = fieldStr(cat, `${side}_label_asym_id`, row), seq = fieldStr(cat, `${side}_label_seq_id`, row);
      const hit = asym && seq ? byLabel.get(`${asym}|${seq}`) : undefined;
      if (hit !== undefined) return hit;
      const ins = nullStr(fieldStr(cat, side === "beg" ? "pdbx_beg_PDB_ins_code" : "pdbx_end_PDB_ins_code", row));
      return byAuthChain.get(`${fieldStr(cat, `${side}_auth_asym_id`, row)}|${fieldStr(cat, `${side}_auth_seq_id`, row)}|${ins}`);
    };
    const a = resolve("beg"), b = resolve("end");
    if (a === undefined || b === undefined || b < a) return;
    secondary.push({ kind, chain: residues[a]!.chain!, startResidue: a, endResidue: b });
  };
  const conf = block?.category("struct_conf");
  for (let r = 0; r < (conf?.rowCount ?? 0); r++) {
    const type = fieldStr(conf, "conf_type_id", r).toUpperCase();
    if (type.startsWith("HELX")) addSpan("helix", conf, r);
    else if (type === "STRN") addSpan("sheet", conf, r);
  }
  const sheets = block?.category("struct_sheet_range");
  for (let r = 0; r < (sheets?.rowCount ?? 0); r++) addSpan("sheet", sheets, r);

  // --- Bonds -----------------------------------------------------------------------------------------
  let bonds: MolScene["bonds"];
  if (options.bonds !== false && count > 0) {
    const bondA: number[] = [], bondB: number[] = [], bondOrder: number[] = [];
    const add = (a: number, b: number, order: number) => { bondA.push(a); bondB.push(b); bondOrder.push(order); };

    // Templates from the file's chem_comp_bond (wwPDB files now embed them for every component)
    const templates = new Map<string, [string, string, number][]>();
    const ccb = block?.category("chem_comp_bond");
    if (ccb) {
      const comp = ccb.getField("comp_id"), a1 = ccb.getField("atom_id_1"), a2 = ccb.getField("atom_id_2"), ord = ccb.getField("value_order");
      for (let r = 0; comp && a1 && a2 && r < ccb.rowCount; r++) {
        const o = (ord?.str(r) ?? "sing").toLowerCase();
        const order = o === "doub" ? 2 : o === "trip" ? 3 : o === "quad" ? 4 : 1;
        const list = templates.get(comp.str(r)) ?? [];
        list.push([a1.str(r), a2.str(r), order]);
        templates.set(comp.str(r), list);
      }
    }

    // Atoms of different conformers never bond; a shared atom (no altloc) bonds with each conformer
    const altCompatible = (a: number, b: number) => atomAlt[a]! < 0 || atomAlt[b]! < 0 || atomAlt[a] === atomAlt[b];
    const nameMap = (ri: number, comp?: string) => {
      const m = new Map<string, number[]>();
      for (let i = residueFirstAtom[ri]!; i < residueAtomEnd[ri]!; i++) {
        if (comp !== undefined && atomComp[i] !== comp) continue;
        const list = m.get(names[i]!);
        if (list) list.push(i); else m.set(names[i]!, [i]);
      }
      return m;
    };
    for (let ri = 0; ri < residues.length; ri++) {
      if (onProgress && (ri & 0x1fff) === 0) onProgress({ stage: "bonds", done: ri, total: residues.length });
      const first = residueFirstAtom[ri]!, end = residueAtomEnd[ri]!;
      if (end - first < 2) continue;
      // Microheterogeneous residues have several comps: template each comp's atoms separately
      const comps = new Set<string>();
      for (let i = first; i < end; i++) comps.add(atomComp[i]!);
      for (const comp of comps) {
        const tpl = templates.get(comp);
        if (tpl) {
          const m = nameMap(ri, comps.size > 1 ? comp : undefined);
          for (const [n1, n2, order] of tpl) {
            const as = m.get(n1), bs = m.get(n2);
            if (!as || !bs) continue;
            for (const a of as) for (const b of bs) if (altCompatible(a, b)) add(a, b, order);
          }
        } else {
          // Distance heuristic within the residue (covalent radii + 0.45 A tolerance)
          for (let i = first; i < end; i++) {
            if (comps.size > 1 && atomComp[i] !== comp) continue;
            for (let j = i + 1; j < end; j++) {
              if (comps.size > 1 && atomComp[j] !== comp) continue;
              if ((element[i] === 1 && element[j] === 1) || !altCompatible(i, j)) continue;
              const dx = positions[i * 3]! - positions[j * 3]!, dy = positions[i * 3 + 1]! - positions[j * 3 + 1]!, dz = positions[i * 3 + 2]! - positions[j * 3 + 2]!;
              const d2 = dx * dx + dy * dy + dz * dz, lim = covByAtom[i]! + covByAtom[j]! + 0.45;
              if (d2 > 0.16 && d2 <= lim * lim) add(i, j, 1);
            }
          }
        }
      }
    }

    // Polymer links between consecutive residues of the same label chain (never across gaps)
    const linked = new Set<number>();
    const findAtom = (ri: number, name: string, alt?: string) => {
      for (let i = residueFirstAtom[ri]!; i < residueAtomEnd[ri]!; i++) if (names[i] === name || (alt !== undefined && names[i] === alt)) return i;
      return -1;
    };
    const within = (a: number, b: number, max: number) => {
      const dx = positions[a * 3]! - positions[b * 3]!, dy = positions[a * 3 + 1]! - positions[b * 3 + 1]!, dz = positions[a * 3 + 2]! - positions[b * 3 + 2]!;
      return dx * dx + dy * dy + dz * dz <= max * max;
    };
    for (const seg of chainSegments) {
      for (let ri = seg.startResidue; ri < seg.endResidue; ri++) {
        const c = findAtom(ri, "C"), n = findAtom(ri + 1, "N");
        if (c >= 0 && n >= 0 && within(c, n, 2.0)) { add(c, n, 1); linked.add(c * count + n); continue; }
        const o3 = findAtom(ri, "O3'", "O3*"), p = findAtom(ri + 1, "P");
        if (o3 >= 0 && p >= 0 && within(o3, p, 2.4)) { add(o3, p, 1); linked.add(o3 * count + p); }
      }
    }

    // struct_conn: covalent and disulfide links inside the asymmetric unit
    const inter = new Set<number>(); // inter-residue pairs already bonded (a < b)
    const conn = block?.category("struct_conn");
    const COVALENT = new Set(["covale", "covale_base", "covale_phosphate", "covale_sugar", "disulf"]);
    for (let r = 0; r < (conn?.rowCount ?? 0); r++) {
      if (!COVALENT.has(fieldStr(conn, "conn_type_id", r).toLowerCase())) continue;
      const sym1 = fieldStr(conn, "ptnr1_symmetry", r), sym2 = fieldStr(conn, "ptnr2_symmetry", r);
      if ((sym1 && sym1 !== "1_555") || (sym2 && sym2 !== "1_555")) continue;
      const partner = (p: 1 | 2) => {
        const asym = fieldStr(conn, `ptnr${p}_label_asym_id`, r);
        const ins = nullStr(fieldStr(conn, `pdbx_ptnr${p}_PDB_ins_code`, r));
        const seq = fieldStr(conn, `ptnr${p}_auth_seq_id`, r);
        let ri = byAuth.get(`${asym}|${seq}|${ins}`);
        if (ri === undefined) { const ls = fieldStr(conn, `ptnr${p}_label_seq_id`, r); if (ls) ri = byLabel.get(`${asym}|${ls}`); }
        if (ri === undefined) return -1;
        return findAtom(ri, fieldStr(conn, `ptnr${p}_label_atom_id`, r));
      };
      const a = partner(1), b = partner(2);
      if (a < 0 || b < 0 || a === b || !altCompatible(a, b) || linked.has(a * count + b) || linked.has(b * count + a)) continue;
      const o = fieldStr(conn, "pdbx_value_order", r).toLowerCase();
      add(a, b, o === "doub" ? 2 : o === "trip" ? 3 : 1);
      inter.add(a < b ? a * count + b : b * count + a);
    }

    // Unannotated ligand links by distance (as Mol* does): ligand atoms (non-polymer, non-water) to atoms of
    // other residues, tight tolerance; hydrogens, waters and metals (coordination, not covalent) excluded.
    const isLigandResidue = (ri: number) => Number.isNaN(residueLabelSeq[ri]!) && !WATER.has(residues[ri]!.name);
    const bondable = (i: number) => element[i] !== 1 && !METALS.has(element[i]!) && !WATER.has(atomComp[i]!);
    let ligandAtoms = 0;
    for (let ri = 0; ri < residues.length; ri++) if (isLigandResidue(ri)) ligandAtoms += residueAtomEnd[ri]! - residueFirstAtom[ri]!;
    if (ligandAtoms > 0) {
      const grid = new AtomGrid(positions, count, 3);
      for (let ri = 0; ri < residues.length; ri++) {
        if (!isLigandResidue(ri)) continue;
        for (let i = residueFirstAtom[ri]!; i < residueAtomEnd[ri]!; i++) {
          if (!bondable(i)) continue;
          grid.forNeighbors(i, (j) => {
            if (residueIndex[j] === ri || !bondable(j) || !altCompatible(i, j)) return;
            const key = i < j ? i * count + j : j * count + i;
            if (inter.has(key)) return;
            const dx = positions[i * 3]! - positions[j * 3]!, dy = positions[i * 3 + 1]! - positions[j * 3 + 1]!, dz = positions[i * 3 + 2]! - positions[j * 3 + 2]!;
            // Shorter than 0.8 A is an overlapping alternative (e.g. two ligands modelled in one site), not a bond
            const lim = covByAtom[i]! + covByAtom[j]! + 0.3, d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > 0.64 && d2 <= lim * lim) { add(i, j, 1); inter.add(key); }
          });
        }
      }
    }

    bonds = { count: bondA.length, indexA: Uint32Array.from(bondA), indexB: Uint32Array.from(bondB), order: Uint8Array.from(bondOrder) };
  }

  const entryId = fieldStr(block?.category("entry"), "id", 0) || block?.name || undefined;
  const scene: MolScene = {
    atoms: { count, positions, radii, colors, element, chainIndex, residueIndex, serial, names },
    bonds,
    backbone: backbone && { positions: backbone.positions, segments: backbone.segments, residueOfPoint: backbone.residueOfPoint, orientation: backbone.orientation },
    tables: {
      chains: chainIds.map((id) => ({ id })),
      residues,
      chainSegments: chainSegments.length ? chainSegments : undefined,
      secondary: secondary.length ? secondary : undefined,
    },
    bbox: count > 0 ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } : undefined,
    metadata: { pdbId: entryId, modelCount: Math.max(1, models.size), warnings },
  };
  try { scene.index = buildSceneIndex(scene); } catch { /* index is optional */ }
  return scene;
}
