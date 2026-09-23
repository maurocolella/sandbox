/**
 * CIF document layer: blocks, categories and typed column access (whitepapers/mmcif-parser.md §3, §6).
 *
 * parseCif() makes one indexing pass: it records each block's categories, their tags, value counts and
 * the raw byte range of every loop, but stores no values (memory stays near the file size, even for
 * 1 GB+ entries). A loop category is re-tokenized only when first accessed:
 *   - getField() builds a compact offset table for the category and exposes per-row str/int/float/
 *     valueKind (valueKind 0/1/2 = present / '.' / '?', matching BinaryCIF masks);
 *   - decodeColumns() makes a single pass straight into typed arrays or interned string codes, which is
 *     the fast path for large loops such as _atom_site.
 * Names are case-insensitive (CIF 1.1); original spellings are kept.
 */
import { CifTokenizer, Tok, ValueKind, decodeBytes, type TokKind, type TokenizerWarning } from "./tokenizer.js";
import { parseFloatBytes, parseIntBytes } from "./numbers.js";
import { ByteInterner } from "./intern.js";

export const Presence = { Present: 0, Inapplicable: 1, Unknown: 2 } as const; // value, '.', '?'
export type PresenceType = (typeof Presence)[keyof typeof Presence];

export type DocumentWarningCode =
  | "value-without-tag"
  | "tag-without-value"
  | "loop-value-count"
  | "duplicate-tag"
  | "duplicate-category"
  | "mixed-category-loop"
  | "data-before-block"
  | "unexpected-keyword";

export interface CifWarning {
  code: DocumentWarningCode | TokenizerWarning["code"];
  line: number;
  detail?: string;
}

/** Column access shared by text CIF and (later) BinaryCIF. Null values give "" / NaN. */
export interface CifField {
  readonly name: string;
  readonly rowCount: number;
  valueKind(row: number): PresenceType;
  str(row: number): string;
  int(row: number): number;
  float(row: number): number;
}

export type ColumnType = "f32" | "f64" | "i32" | "str";
export interface ColumnSpec { field: string; type: ColumnType }
export interface DecodedColumn {
  /** f32/f64: Float32Array/Float64Array (NaN for nulls); i32: Int32Array (0 for nulls); str: codes into `dictionary`. */
  values: Float32Array | Float64Array | Int32Array | Uint32Array;
  dictionary?: string[];
  /** Per-row Presence, only allocated when the column has at least one '.' or '?'. */
  mask?: Uint8Array;
}

const MAX_WARNINGS = 1000;
/** Token kind recorded for a tag that had no value; read back as '?'. */
const MISSING = 255;

/** Offsets of each value (row-major) in the source bytes, plus the value kind for null detection. */
interface TokenTable { starts: Uint32Array; ends: Uint32Array; kinds: Uint8Array }

export class CifCategory {
  /** Lower-case category name without the leading underscore, e.g. "atom_site". */
  readonly name: string;
  /** Field names as written (without the category prefix). */
  readonly fieldNames: string[];
  readonly isLoop: boolean;
  readonly rowCount: number;
  private readonly index = new Map<string, number>();
  private table: TokenTable | null;
  // loops: raw byte range of the values, for re-tokenizing on demand
  private readonly range: { start: number; end: number; line: number } | null;

  constructor(
    private readonly bytes: Uint8Array,
    name: string,
    fieldNames: string[],
    isLoop: boolean,
    rowCount: number,
    table: TokenTable | null,
    range: { start: number; end: number; line: number } | null,
  ) {
    this.name = name;
    this.fieldNames = fieldNames;
    this.isLoop = isLoop;
    this.rowCount = rowCount;
    this.table = table;
    this.range = range;
    fieldNames.forEach((f, i) => { if (!this.index.has(f.toLowerCase())) this.index.set(f.toLowerCase(), i); });
  }

  /** @internal Pair (non-loop) categories are filled in once their scope closes. */
  static pairs(bytes: Uint8Array, name: string): CifCategory {
    return new CifCategory(bytes, name, [], false, 1, { starts: new Uint32Array(0), ends: new Uint32Array(0), kinds: new Uint8Array(0) }, null);
  }

  /** @internal */
  setPairs(fields: string[], table: TokenTable): void {
    this.fieldNames.push(...fields);
    fields.forEach((f, i) => { if (!this.index.has(f.toLowerCase())) this.index.set(f.toLowerCase(), i); });
    this.table = table;
  }

  has(field: string): boolean {
    return this.index.has(field.toLowerCase());
  }

  getField(field: string): CifField | undefined {
    const col = this.index.get(field.toLowerCase());
    if (col === undefined) return undefined;
    return new TableField(this.fieldNames[col]!, this.bytes, this.tokens(), col, this.fieldNames.length, this.rowCount);
  }

  /** Columns decoded during parseCif() when requested with `decode`; undefined otherwise. */
  decoded?: Record<string, DecodedColumn>;

  /** Decode several columns in one pass over the category. Missing fields are absent from the result. */
  decodeColumns<K extends string>(spec: Record<K, ColumnSpec>): Partial<Record<K, DecodedColumn>> {
    const dec = new ColumnDecoder(this.bytes, this.fieldNames, spec, this.rowCount);
    const total = this.rowCount * this.fieldNames.length;
    if (this.table) {
      const t = this.table;
      for (let i = 0; i < total; i++) dec.store(t.starts[i]!, t.ends[i]!, t.kinds[i]!);
    } else if (this.range) {
      const tz = CifTokenizer.range(this.bytes, this.range.start, this.range.end, this.range.line);
      for (let i = 0; i < total; ) {
        const k = tz.next();
        if (k === Tok.Eof) break;
        if (k !== Tok.Value) continue;
        dec.store(tz.start, tz.end, tz.valueKind);
        i++;
      }
    }
    return dec.finish(this.rowCount) as Partial<Record<K, DecodedColumn>>;
  }

  private tokens(): TokenTable {
    if (this.table) return this.table;
    const total = this.rowCount * this.fieldNames.length;
    const starts = new Uint32Array(total), ends = new Uint32Array(total), kinds = new Uint8Array(total);
    const r = this.range!;
    const tz = CifTokenizer.range(this.bytes, r.start, r.end, r.line);
    let i = 0;
    while (i < total) {
      const k = tz.next();
      if (k === Tok.Eof) break;
      if (k !== Tok.Value) continue;
      starts[i] = tz.start; ends[i] = tz.end; kinds[i] = tz.valueKind;
      i++;
    }
    return (this.table = { starts, ends, kinds });
  }
}

/**
 * Decodes values (fed in row-major order) straight into typed arrays or interned string codes. Output
 * arrays grow as needed, so it also works while indexing, before the row count is known.
 */
class ColumnDecoder {
  private readonly ncols: number;
  private readonly colType: Int8Array; // -1 skip, 0 f32, 1 f64, 2 i32, 3 str
  private readonly keysByCol: string[][];
  private values: (Float32Array | Float64Array | Int32Array | Uint32Array | null)[];
  private masks: (Uint8Array | null)[];
  private readonly interners: (ByteInterner | null)[];
  private readonly lastStart: Int32Array;
  private readonly lastEnd: Int32Array;
  private readonly lastCode: Uint32Array;
  private capacity: number;
  private col = 0;
  private row = 0;

  constructor(private readonly bytes: Uint8Array, fieldNames: string[], spec: Record<string, ColumnSpec>, capacity: number) {
    const n = (this.ncols = fieldNames.length);
    this.capacity = Math.max(1, capacity);
    this.colType = new Int8Array(n).fill(-1);
    this.keysByCol = Array.from({ length: n }, () => []);
    this.values = new Array(n).fill(null);
    this.masks = new Array(n).fill(null);
    this.interners = new Array(n).fill(null);
    this.lastStart = new Int32Array(n).fill(-1);
    this.lastEnd = new Int32Array(n);
    this.lastCode = new Uint32Array(n);
    const index = new Map<string, number>();
    fieldNames.forEach((f, i) => { if (!index.has(f.toLowerCase())) index.set(f.toLowerCase(), i); });
    for (const [key, sp] of Object.entries(spec)) {
      const col = index.get(sp.field.toLowerCase());
      if (col === undefined) continue;
      this.keysByCol[col]!.push(key);
      if (this.colType[col]! >= 0) continue; // same field requested twice: shared output
      const t = sp.type;
      this.colType[col] = t === "f32" ? 0 : t === "f64" ? 1 : t === "i32" ? 2 : 3;
      this.values[col] = alloc(this.colType[col]!, this.capacity);
      if (t === "str") this.interners[col] = new ByteInterner();
    }
  }

  store(s: number, e: number, kind: number): void {
    const col = this.col, type = this.colType[col]!;
    if (type >= 0) {
      const row = this.row;
      if (row >= this.capacity) this.grow();
      const values = this.values[col]!, bytes = this.bytes;
      if (kind === MISSING || (kind === ValueKind.Bare && e - s === 1 && (bytes[s] === 46 || bytes[s] === 63))) {
        let mask = this.masks[col];
        if (!mask) mask = this.masks[col] = new Uint8Array(this.capacity);
        mask[row] = kind !== MISSING && bytes[s] === 46 ? Presence.Inapplicable : Presence.Unknown;
        if (type <= 1) values[row] = NaN;
        else if (type === 3) values[row] = this.interners[col]!.intern(bytes, s, s); // ""
      } else if (type <= 1) {
        values[row] = parseFloatBytes(bytes, s, e);
      } else if (type === 2) {
        values[row] = parseIntBytes(bytes, s, e);
      } else {
        // Most string columns repeat the previous row's value: compare bytes before hashing
        const ls = this.lastStart[col]!, n = e - s;
        let same = ls >= 0 && this.lastEnd[col]! - ls === n;
        for (let j = 0; same && j < n; j++) same = bytes[ls + j] === bytes[s + j];
        const code = same ? this.lastCode[col]! : this.interners[col]!.intern(bytes, s, e);
        values[row] = code;
        this.lastStart[col] = s; this.lastEnd[col] = e; this.lastCode[col] = code;
      }
    }
    if (++this.col === this.ncols) { this.col = 0; this.row++; }
  }

  /** Trim to `rows` rows and return columns by requested key. */
  finish(rows: number): Record<string, DecodedColumn> {
    const out: Record<string, DecodedColumn> = {};
    for (let col = 0; col < this.ncols; col++) {
      if (this.colType[col]! < 0) continue;
      const values = this.values[col]!;
      const col_: DecodedColumn = { values: values.length === rows ? values : values.slice(0, rows) };
      const mask = this.masks[col];
      if (mask) col_.mask = mask.length === rows ? mask : mask.slice(0, rows);
      const it = this.interners[col];
      if (it) col_.dictionary = it.values;
      for (const key of this.keysByCol[col]!) out[key] = col_;
    }
    return out;
  }

  private grow(): void {
    const cap = this.capacity * 2;
    for (let col = 0; col < this.ncols; col++) {
      const v = this.values[col];
      if (v) { const nv = alloc(this.colType[col]!, cap); nv.set(v as never); this.values[col] = nv; }
      const m = this.masks[col];
      if (m) { const nm = new Uint8Array(cap); nm.set(m); this.masks[col] = nm; }
    }
    this.capacity = cap;
  }
}

function alloc(type: number, n: number): Float32Array | Float64Array | Int32Array | Uint32Array {
  return type === 0 ? new Float32Array(n) : type === 1 ? new Float64Array(n) : type === 2 ? new Int32Array(n) : new Uint32Array(n);
}

class TableField implements CifField {
  constructor(
    readonly name: string,
    private readonly bytes: Uint8Array,
    private readonly t: TokenTable,
    private readonly col: number,
    private readonly ncols: number,
    readonly rowCount: number,
  ) {}

  valueKind(row: number): PresenceType {
    const i = row * this.ncols + this.col;
    const s = this.t.starts[i]!, kind = this.t.kinds[i]!;
    if (kind === MISSING) return Presence.Unknown;
    if (kind !== ValueKind.Bare || this.t.ends[i]! - s !== 1) return Presence.Present;
    const b = this.bytes[s];
    return b === 46 ? Presence.Inapplicable : b === 63 ? Presence.Unknown : Presence.Present;
  }

  str(row: number): string {
    if (this.valueKind(row) !== Presence.Present) return "";
    const i = row * this.ncols + this.col;
    return decodeBytes(this.bytes, this.t.starts[i]!, this.t.ends[i]!);
  }

  float(row: number): number {
    if (this.valueKind(row) !== Presence.Present) return NaN;
    const i = row * this.ncols + this.col;
    return parseFloatBytes(this.bytes, this.t.starts[i]!, this.t.ends[i]!);
  }

  int(row: number): number {
    if (this.valueKind(row) !== Presence.Present) return NaN;
    const i = row * this.ncols + this.col;
    return parseIntBytes(this.bytes, this.t.starts[i]!, this.t.ends[i]!);
  }
}

export class CifBlock {
  /** Categories by lower-case name, in file order. */
  readonly categories = new Map<string, CifCategory>();
  readonly saveFrames: CifBlock[] = [];
  constructor(readonly name: string) {}

  /** Look up a category by name, case-insensitively, with or without the leading underscore. */
  category(name: string): CifCategory | undefined {
    const n = name.toLowerCase();
    return this.categories.get(n.startsWith("_") ? n.slice(1) : n);
  }
}

export interface CifDocument {
  blocks: CifBlock[];
  warnings: CifWarning[];
  warningCount: number;
  /** The source bytes; categories read values from them lazily. */
  bytes: Uint8Array;
}

/** Split "_cat.item" into [lower-case category, item as written]; tags without '.' use category "". */
function readLoopValues(tz: CifTokenizer, dec: ColumnDecoder | null): { count: number; end: number; next: TokKind } {
  let count = 0, end = tz.rawEnd, k: TokKind = Tok.Value;
  if (dec) {
    do { dec.store(tz.start, tz.end, tz.valueKind); count++; end = tz.rawEnd; k = tz.next(); } while (k === Tok.Value);
  } else {
    do { count++; end = tz.rawEnd; k = tz.next(); } while (k === Tok.Value);
  }
  return { count, end, next: k };
}

function splitTag(tag: string): [string, string] {
  const dot = tag.indexOf(".");
  return dot > 0 ? [tag.slice(1, dot).toLowerCase(), tag.slice(dot + 1)] : ["", tag.slice(1)];
}

interface PairBuilder { fields: string[]; starts: number[]; ends: number[]; kinds: number[] }

export interface ParseCifOptions {
  /**
   * Columns to decode while indexing, by category name (e.g. { atom_site: {...} }). Large loops are then
   * tokenized once instead of twice; results land in `category.decoded`.
   */
  decode?: Record<string, Record<string, ColumnSpec>>;
}

/** Index a complete CIF file (already decompressed). */
export function parseCif(bytes: Uint8Array, options: ParseCifOptions = {}): CifDocument {
  const eager = new Map(Object.entries(options.decode ?? {}).map(([k, v]) => [k.toLowerCase().replace(/^_/, ""), v]));
  const doc: CifDocument = { blocks: [], warnings: [], warningCount: 0, bytes };
  const warn = (code: CifWarning["code"], line: number, detail?: string) => {
    doc.warningCount++;
    if (doc.warnings.length < MAX_WARNINGS) doc.warnings.push(detail === undefined ? { code, line } : { code, line, detail });
  };

  let block: CifBlock | null = null;
  let frame: CifBlock | null = null;
  const target = (line: number): CifBlock => {
    if (frame) return frame;
    if (!block) {
      warn("data-before-block", line);
      block = new CifBlock("");
      doc.blocks.push(block);
    }
    return block;
  };
  // Pair (non-loop) categories of the current scope: created at their first tag (file order), filled at scope end
  let pairs = new Map<CifCategory, PairBuilder>();
  const flushPairs = () => {
    for (const [cat, b] of pairs) {
      cat.setPairs(b.fields, { starts: Uint32Array.from(b.starts), ends: Uint32Array.from(b.ends), kinds: Uint8Array.from(b.kinds) });
    }
    pairs = new Map();
  };

  // Pending pair tag, and the loop being read
  let pendingTag: string | null = null, pendingLine = 0;
  let loopTags: string[] | null = null;
  let loopLine = 0, loopValues = 0, loopStart = 0, loopEnd = 0, loopValueLine = 0;
  let loopDecoder: ColumnDecoder | null = null;

  const finishPending = () => {
    if (pendingTag !== null) {
      warn("tag-without-value", pendingLine, pendingTag);
      addPair(pendingTag, 0, 0, MISSING, pendingLine);
      pendingTag = null;
    }
  };
  const addPair = (tag: string, start: number, end: number, kind: number, line: number) => {
    const [name, field] = splitTag(tag);
    const owner = target(line);
    let cat = owner.categories.get(name);
    let p = cat ? pairs.get(cat) : undefined;
    if (!p) {
      if (cat) { warn("duplicate-category", line, name); return; } // already a loop, or pairs of an earlier scope
      cat = CifCategory.pairs(bytes, name);
      owner.categories.set(name, cat);
      p = { fields: [], starts: [], ends: [], kinds: [] };
      pairs.set(cat, p);
    }
    const existing = p.fields.findIndex((f) => f.toLowerCase() === field.toLowerCase());
    if (existing >= 0) {
      warn("duplicate-tag", line, tag);
      p.starts[existing] = start; p.ends[existing] = end; p.kinds[existing] = kind;
    } else {
      p.fields.push(field); p.starts.push(start); p.ends.push(end); p.kinds.push(kind);
    }
  };
  const finishLoop = () => {
    if (!loopTags) return;
    const [cat] = splitTag(loopTags[0]!);
    const fields = loopTags.map((t) => {
      const [c, f] = splitTag(t);
      if (c !== cat) warn("mixed-category-loop", loopLine, t);
      return f;
    });
    const ncols = fields.length;
    if (loopValues % ncols !== 0) warn("loop-value-count", loopLine, `${cat}: ${loopValues} values for ${ncols} columns`);
    const rows = Math.floor(loopValues / ncols);
    const owner = target(loopLine);
    if (owner.categories.has(cat)) {
      warn("duplicate-category", loopLine, cat);
    } else {
      const category = new CifCategory(bytes, cat, fields, true, rows, rows === 0 ? { starts: new Uint32Array(0), ends: new Uint32Array(0), kinds: new Uint8Array(0) } : null, rows === 0 ? null : { start: loopStart, end: loopEnd, line: loopValueLine });
      if (loopDecoder) category.decoded = loopDecoder.finish(rows);
      owner.categories.set(cat, category);
    }
    loopTags = null;
    loopDecoder = null;
  };
  const closeScope = () => { finishPending(); finishLoop(); flushPairs(); };

  const tz = CifTokenizer.of(bytes);
  let carried: TokKind | null = null; // token that ended a loop's values, still to be handled
  for (let k = tz.next(); k !== Tok.Eof; k = carried ?? tz.next()) {
    carried = null;
    switch (k) {
      case Tok.Value: {
        if (pendingTag !== null) {
          addPair(pendingTag, tz.start, tz.end, tz.valueKind, pendingLine);
          pendingTag = null;
        } else if (loopTags && loopValues === 0) {
          loopStart = tz.rawStart; loopValueLine = tz.line;
          const spec = eager.get(splitTag(loopTags[0]!)[0]);
          if (spec) {
            const fields = loopTags.map((t) => splitTag(t)[1]);
            // ~100 bytes per row in wwPDB atom_site; the decoder grows if the guess is short
            loopDecoder = new ColumnDecoder(bytes, fields, spec, Math.ceil((bytes.length - tz.rawStart) / (fields.length * 4)));
          }
          // Tight loop over the values (locals only), then hand the terminating token back
          const r = readLoopValues(tz, loopDecoder);
          loopValues = r.count;
          loopEnd = r.end;
          carried = r.next;
        } else {
          warn("value-without-tag", tz.line, tz.text().slice(0, 40));
        }
        break;
      }
      case Tok.Tag: {
        if (loopTags && loopValues === 0) { loopTags.push(tz.text()); break; }
        finishLoop();
        finishPending();
        pendingTag = tz.text();
        pendingLine = tz.line;
        break;
      }
      case Tok.Loop:
        finishPending(); finishLoop();
        loopTags = []; loopLine = tz.line; loopValues = 0;
        break;
      case Tok.Data: {
        closeScope();
        frame = null;
        block = new CifBlock(tz.text());
        doc.blocks.push(block);
        break;
      }
      case Tok.Save: {
        closeScope();
        const parent = block ?? target(tz.line);
        frame = new CifBlock(tz.text());
        parent.saveFrames.push(frame);
        break;
      }
      case Tok.SaveEnd:
        closeScope();
        if (!frame) warn("unexpected-keyword", tz.line, "save_");
        frame = null;
        break;
      case Tok.Stop: // STAR loop terminator
        finishPending(); finishLoop();
        break;
      case Tok.Global: // treated as a block (Refmac monomer libraries)
        closeScope();
        warn("unexpected-keyword", tz.line, "global_");
        frame = null;
        block = new CifBlock("global_");
        doc.blocks.push(block);
        break;
    }
  }
  closeScope();
  for (const w of tz.warnings) {
    doc.warningCount++;
    if (doc.warnings.length < MAX_WARNINGS) doc.warnings.push({ code: w.code, line: w.line });
  }
  return doc;
}
