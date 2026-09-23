# cif-parser

A minimal-dependency CIF, mmCIF and BinaryCIF reader for the browser and web workers. It works on bytes, can stream, and exposes data as columns. The design follows `whitepapers/mmcif-parser.md`.

Status: **tokenizer, plus the document, category and column layer**. BinaryCIF decoding and the mmCIF-to-`MolScene` loader come next.

## Documents, categories and columns

```ts
import { parseCif, Presence } from "cif-parser";

const doc = parseCif(bytes, { decode: { atom_site: {             // optional eager decode, one pass
  x: { field: "Cartn_x", type: "f32" }, atom: { field: "label_atom_id", type: "str" }, seq: { field: "label_seq_id", type: "i32" },
} } });
const block = doc.blocks[0];
const site = block.category("atom_site");                        // case-insensitive, "_" optional
site.decoded.x.values;                                           // Float32Array
site.decoded.atom.values, site.decoded.atom.dictionary;          // Uint32Array codes + string[]
site.decoded.seq.mask;                                           // Presence per row, only if any '.'/'?'
block.category("struct")?.getField("title")?.str(0);             // lazy per-field access
```

- **Indexing** (`parseCif`) makes one pass and stores no values. It records blocks, save frames, categories, tags, row counts and each loop's byte range, so memory stays near the file size.
- **Lazy access.** `getField()` tokenizes a category the first time it's used and gives `str`, `int`, `float` and `valueKind` per row. `valueKind` is 0 (present), 1 (`.`) or 2 (`?`), the same convention as BinaryCIF masks.
- **Column decoding.** `decodeColumns(spec)`, or `decode` at parse time, writes straight into Float32/Float64/Int32 arrays or interned string codes, with masks only where nulls exist. Numbers are parsed from bytes and are bit-identical to `Number()` (Clinger fast path); a trailing `(su)` is ignored.
- **Leniency.** Structural problems produce warnings rather than failures: a tag without a value (read as `?`), a loop value count that isn't a multiple of its columns, duplicate tags (last wins) or categories, values before any block, mixed-category loops, `global_`, and `stop_`.
- **Speed.** Parsing plus an eager 18-column `_atom_site` decode takes 3J3Q (242 MB, 2.44 M atoms) in 1.3 s and 36ZA (1.2 GB, 11.2 M atoms) in 6.9 s. Measure with `node bench/document.mjs file.cif.gz`.

## Tokenizer

```ts
import { CifTokenizer, Tok } from "cif-parser";

const tz = CifTokenizer.of(bytes);           // or: new CifTokenizer(); push(chunk)...; finish()
for (let k = tz.next(); k !== Tok.Eof; k = tz.next()) {
  if (k === Tok.NeedMore) break;             // streaming only: push() the next chunk, then keep calling next()
  // tz.kind, tz.start/end (byte offsets into tz.buffer, quotes stripped), tz.valueKind, tz.line, tz.isNull(), tz.text()
}
```

- **CIF 1.1 lexical rules.**
  - A quote closes only when followed by whitespace.
  - A `;` in column 1 opens a text field.
  - `#` is literal inside values.
  - Keywords are case-insensitive whole words.
  - A quoted `'?'` or `'.'` is a literal string; `isNull()` is true only for the bare forms.
- **Bytes, not strings.** Nothing decodes the whole file, so 1 GB+ entries (36ZA) tokenize without hitting V8's string limit. Token text is decoded only on demand.
- **Resumable.** Streaming and whole-buffer input run the same code and produce identical tokens for any chunk size.
- **Lenient, with warnings** (`tz.warnings`) for deviations real files contain: a BOM, unterminated quotes or text fields, a quote closed by `#`, a text-field close not followed by whitespace, reserved leading characters, and the CIF 2.0 magic (not supported yet).
- **Speed.** About 300–340 MB/s in Node 25 (`node bench/tokenize.mjs file.cif.gz`): 3J3Q (242 MB) in 0.79 s, 36ZA (1.2 GB) in 3.5 s.

Tests: `pnpm test` runs the unit tests, chunk invariance and fuzzing. Corpus-scale checks live in `mol-harness` (`pnpm --filter mol-harness test:cif`, with `CIF_GIANTS=1` to include the three largest entries).
