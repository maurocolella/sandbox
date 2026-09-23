import { describe, it, expect } from "vitest";
import { parseCif, Presence, parseFloatBytes, parseIntBytes, ByteInterner } from "../src/index.js";

const enc = new TextEncoder();
const doc = (s: string) => parseCif(enc.encode(s));
const codes = (s: string) => doc(s).warnings.map((w) => w.code);

describe("parseCif: blocks and categories", () => {
  const text = `data_TEST
_entry.id TEST
_struct.title 'A "quoted" title'
_struct.pdbx_descriptor
;multi
line
;
loop_
_atom_site.id
_atom_site.label_atom_id
_atom_site.Cartn_x
_atom_site.label_seq_id
1 N    1.500 1
2 "O5'" -2.25 .
3 CA   3e1  ?
#
_cell.length_a 63.150
data_SECOND
loop_
_x.a
'?' ?
`;

  it("indexes blocks and categories in file order, case-insensitively", () => {
    const d = doc(text);
    expect(d.blocks.map((b) => b.name)).toEqual(["TEST", "SECOND"]);
    const b = d.blocks[0]!;
    expect([...b.categories.keys()]).toEqual(["entry", "struct", "atom_site", "cell"]);
    expect(b.category("_ATOM_SITE")).toBe(b.category("atom_site"));
    expect(d.warnings).toEqual([]);
  });

  it("reads pair categories as one-row categories", () => {
    const s = doc(text).blocks[0]!.category("struct")!;
    expect(s.isLoop).toBe(false);
    expect(s.rowCount).toBe(1);
    expect(s.getField("title")!.str(0)).toBe('A "quoted" title');
    expect(s.getField("PDBX_DESCRIPTOR")!.str(0)).toBe("multi\nline");
  });

  it("reads loop fields lazily with str/int/float/valueKind", () => {
    const a = doc(text).blocks[0]!.category("atom_site")!;
    expect(a.rowCount).toBe(3);
    expect(a.fieldNames).toEqual(["id", "label_atom_id", "Cartn_x", "label_seq_id"]);
    const name = a.getField("label_atom_id")!, x = a.getField("cartn_x")!, seq = a.getField("label_seq_id")!;
    expect([0, 1, 2].map((r) => name.str(r))).toEqual(["N", "O5'", "CA"]);
    expect([0, 1, 2].map((r) => x.float(r))).toEqual([1.5, -2.25, 30]);
    expect([0, 1, 2].map((r) => seq.valueKind(r))).toEqual([Presence.Present, Presence.Inapplicable, Presence.Unknown]);
    expect(seq.int(0)).toBe(1);
    expect(Number.isNaN(seq.int(1))).toBe(true);
    expect(a.getField("missing")).toBeUndefined();
  });

  it("keeps quoted '?' as a literal", () => {
    const f = doc(text).blocks[1]!.category("x")!.getField("a")!;
    expect(f.rowCount).toBe(2);
    expect([f.valueKind(0), f.str(0)]).toEqual([Presence.Present, "?"]);
    expect(f.valueKind(1)).toBe(Presence.Unknown);
  });

  it("decodes columns in one pass into typed arrays, interned strings and masks", () => {
    const a = doc(text).blocks[0]!.category("atom_site")!;
    const c = a.decodeColumns({
      x: { field: "Cartn_x", type: "f32" },
      id: { field: "id", type: "i32" },
      name: { field: "label_atom_id", type: "str" },
      seq: { field: "label_seq_id", type: "i32" },
      nope: { field: "not_there", type: "f64" },
    });
    expect(Array.from(c.x!.values)).toEqual([1.5, -2.25, 30]);
    expect(c.x!.mask).toBeUndefined();
    expect(Array.from(c.id!.values)).toEqual([1, 2, 3]);
    expect(Array.from(c.name!.values).map((i) => c.name!.dictionary![i])).toEqual(["N", "O5'", "CA"]);
    expect(Array.from(c.seq!.mask!)).toEqual([Presence.Present, Presence.Inapplicable, Presence.Unknown]);
    expect(c.nope).toBeUndefined();
  });
});

describe("parseCif: structural deviations", () => {
  it("reports tags without values and reads them as '?'", () => {
    const d = doc("data_x\n_a.b\n_a.c 1\n");
    expect(d.warnings.map((w) => w.code)).toEqual(["tag-without-value"]);
    expect(d.blocks[0]!.category("a")!.getField("b")!.valueKind(0)).toBe(Presence.Unknown);
  });
  it("reports a loop whose value count is not a multiple of its columns, keeping whole rows", () => {
    const d = doc("data_x\nloop_\n_a.x\n_a.y\n1 2 3\n");
    expect(d.warnings.map((w) => w.code)).toEqual(["loop-value-count"]);
    expect(d.blocks[0]!.category("a")!.rowCount).toBe(1);
  });
  it("accepts empty loops, duplicate tags (last wins) and values before any block", () => {
    const empty = doc("data_x\nloop_\n_a.x\n_a.y\ndata_y\n");
    expect(empty.blocks[0]!.category("a")!.rowCount).toBe(0);
    const dup = doc("data_x\n_a.b 1\n_A.B 2\n");
    expect(dup.warnings.map((w) => w.code)).toEqual(["duplicate-tag"]);
    expect(dup.blocks[0]!.category("a")!.getField("b")!.str(0)).toBe("2");
    expect(codes("_a.b 1\n")).toEqual(["data-before-block"]);
  });
  it("reads save frames into their block", () => {
    const d = doc("data_dict\nsave__atom_site.id\n_item.name '_atom_site.id'\nsave_\n_dict.title x\n");
    const b = d.blocks[0]!;
    expect(b.saveFrames.map((f) => f.name)).toEqual(["_atom_site.id"]);
    expect(b.saveFrames[0]!.category("item")!.getField("name")!.str(0)).toBe("_atom_site.id");
    expect(b.category("dict")!.getField("title")!.str(0)).toBe("x");
  });
  it("keeps a mid-line ';' value when a loop is re-tokenized from its range", () => {
    const a = doc("data_x\nloop_\n_a.x _a.y ;v1 w\n;text\n; z\n").blocks[0]!.category("a")!;
    expect([0, 1].map((r) => [a.getField("x")!.str(r), a.getField("y")!.str(r)])).toEqual([[";v1", "w"], ["text", "z"]]);
  });
});

describe("number parsing from bytes", () => {
  const bytes = (s: string) => enc.encode(s);
  const pf = (s: string) => parseFloatBytes(bytes(s), 0, s.length);

  it("handles CIF numeric forms and standard uncertainties", () => {
    expect([pf("1."), pf(".5"), pf("-0.25"), pf("+.5e+2"), pf("1e5"), pf("3.45E1(12)"), pf("1.234(5)")]).toEqual([1, 0.5, -0.25, 50, 1e5, 34.5, 1.234]);
    expect(Number.isNaN(pf("abc"))).toBe(true);
    expect(Number.isNaN(pf("?"))).toBe(true);
    expect(parseIntBytes(bytes("-73"), 0, 3)).toBe(-73);
    expect(parseIntBytes(bytes("2440800"), 0, 7)).toBe(2440800);
  });

  it("is bit-identical to Number() on random fixed and scientific values", () => {
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let mismatches = 0;
    for (let i = 0; i < 200_000; i++) {
      const v = (rand() - 0.5) * Math.pow(10, Math.floor(rand() * 12) - 4);
      const forms = [v.toFixed(3), v.toFixed(Math.floor(rand() * 8)), v.toExponential(Math.floor(rand() * 10)), v.toPrecision(1 + Math.floor(rand() * 16))];
      for (const s of forms) if (!Object.is(pf(s), Number(s))) mismatches++;
    }
    expect(mismatches).toBe(0);
  });
});

describe("ByteInterner", () => {
  it("returns stable codes for equal byte ranges and grows past its initial table", () => {
    const it = new ByteInterner();
    const b = enc.encode("CA N CA O CB");
    expect([it.intern(b, 0, 2), it.intern(b, 3, 4), it.intern(b, 5, 7), it.intern(b, 8, 9)]).toEqual([0, 1, 0, 2]);
    const many = enc.encode(Array.from({ length: 5000 }, (_, i) => `v${i}`).join(" "));
    let pos = 0;
    for (let i = 0; i < 5000; i++) { const e = many.indexOf(32, pos); const end = e < 0 ? many.length : e; it.intern(many, pos, end); pos = end + 1; }
    expect(it.values.length).toBe(5003);
    expect(it.values[3]).toBe("v0");
  });
});
