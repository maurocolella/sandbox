import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { parseCif, Presence, type CifBlock, type DecodedColumn } from "cif-parser";

const HARNESS = join(__dirname, "..");
const CIF_FIXTURES = process.env.CIF_FIXTURES || join(HARNESS, "..", "fixtures", "cif");
const GIANTS = new Set(["36ZA", "9FQR", "8GLV"]); // run with CIF_GIANTS=1

type Counts = Record<string, number>;
const count = (into: Counts, key: string) => { into[key] = (into[key] ?? 0) + 1; };
const strAt = (c: DecodedColumn | undefined, row: number, missing = "?") =>
  !c ? missing : c.mask && c.mask[row] !== Presence.Present ? (c.mask[row] === Presence.Inapplicable ? "." : "?") : c.dictionary![c.values[row]!]!;

const ATOM_SPEC = {
  alt: { field: "label_alt_id", type: "str" },
  comp: { field: "label_comp_id", type: "str" },
  asym: { field: "label_asym_id", type: "str" },
  authAsym: { field: "auth_asym_id", type: "str" },
  seq: { field: "label_seq_id", type: "str" },
  ins: { field: "pdbx_PDB_ins_code", type: "str" },
  element: { field: "type_symbol", type: "str" },
  model: { field: "pdbx_PDB_model_num", type: "str" },
  x: { field: "Cartn_x", type: "f32" },
  id: { field: "id", type: "i32" },
} as const;

/** Recompute, from the column layer, the same summary tools/gemmi_expect.py records with gemmi. */
function summarize(block: CifBlock) {
  const site = block.category("atom_site");
  const rows = site?.rowCount ?? 0;
  const col: Partial<Record<keyof typeof ATOM_SPEC, DecodedColumn>> = site?.decoded ?? {};
  const models: Counts = {}, altlocs: Counts = {}, elements: Counts = {};
  const labelAsyms = new Set<string>(), authAsyms = new Set<string>();
  const residues = new Map<string, Set<string>>();
  let insertionCodeAtoms = 0;
  for (let r = 0; r < rows; r++) {
    count(models, strAt(col.model, r));
    const alt = strAt(col.alt, r);
    if (alt !== "." && alt !== "?") count(altlocs, alt);
    count(elements, strAt(col.element, r));
    labelAsyms.add(strAt(col.asym, r));
    authAsyms.add(strAt(col.authAsym, r));
    const ins = strAt(col.ins, r);
    if (ins !== "." && ins !== "?") insertionCodeAtoms++;
    const seq = strAt(col.seq, r);
    if (seq !== "." && seq !== "?") {
      const key = `${strAt(col.model, r)}|${strAt(col.asym, r)}|${seq}`;
      let comps = residues.get(key);
      if (!comps) residues.set(key, (comps = new Set()));
      comps.add(strAt(col.comp, r));
    }
  }
  const values = (cat: string, field: string): string[] => {
    const c = block.category(cat);
    const f = c?.getField(field);
    if (!c || !f) return [];
    return Array.from({ length: c.rowCount }, (_, r) => (f.valueKind(r) === Presence.Present ? f.str(r) : f.valueKind(r) === Presence.Inapplicable ? "." : "?"));
  };
  const tally = (xs: string[]) => xs.reduce<Counts>((acc, x) => (count(acc, x), acc), {});
  return {
    atomSiteRows: rows,
    models, altlocs, elements,
    labelAsymCount: labelAsyms.size,
    authAsymCount: authAsyms.size,
    insertionCodeAtoms,
    microheterogeneousPositions: [...residues.values()].filter((s) => s.size > 1).length,
    structConnByType: tally(values("struct_conn", "conn_type_id")),
    structConfRows: values("struct_conf", "id").length,
    sheetRangeRows: values("struct_sheet_range", "id").length,
    entityTypes: tally(values("entity", "type")),
    branchSchemeRows: values("pdbx_branch_scheme", "asym_id").length,
    assemblies: values("pdbx_struct_assembly", "id").length,
    operators: values("pdbx_struct_oper_list", "id").length,
  };
}

const corpus = existsSync(CIF_FIXTURES) ? readdirSync(CIF_FIXTURES).filter((f) => f.endsWith(".cif.gz")).sort() : [];

describe("column layer vs gemmi expectations (tricky corpus)", () => {
  it("has fixtures", () => {
    expect(corpus.length, `no .cif.gz under ${CIF_FIXTURES}; fetch them with mol-crawler`).toBeGreaterThan(0);
  });
  for (const file of corpus) {
    const id = file.replace(/\.cif\.gz$/, "");
    it.skipIf(GIANTS.has(id) && !process.env.CIF_GIANTS)(id, () => {
      const expected = JSON.parse(readFileSync(join(HARNESS, "corpus", "expectations", `${id}.json`), "utf8"));
      delete expected.file;
      delete expected.gemmiVersion;
      const bytes = gunzipSync(readFileSync(join(CIF_FIXTURES, file)));
      const t0 = performance.now();
      const doc = parseCif(bytes, { decode: { atom_site: ATOM_SPEC } }); // eager: one pass over atom_site
      const t1 = performance.now();
      expect(doc.blocks.length).toBe(1);
      const summary = summarize(doc.blocks[0]!);
      expect(summary).toEqual(expected);
      expect(doc.warnings).toEqual([]);
      const site = doc.blocks[0]!.category("atom_site");
      if (site && !GIANTS.has(id)) {
        // The lazy path must decode exactly the same columns as the eager one
        const lazy = site.decodeColumns(ATOM_SPEC);
        for (const key of Object.keys(ATOM_SPEC) as (keyof typeof ATOM_SPEC)[]) {
          const a = site.decoded?.[key], b = lazy[key];
          expect(b?.values, key).toEqual(a?.values);
          expect(b?.mask, key).toEqual(a?.mask);
          expect(b?.dictionary, key).toEqual(a?.dictionary);
        }
      }
      // eslint-disable-next-line no-console
      console.log(`[cif-doc] ${id}: parse + atom_site decode ${(t1 - t0).toFixed(0)} ms, ${doc.blocks[0]!.categories.size} categories`);
    }, 600_000);
  }
});
