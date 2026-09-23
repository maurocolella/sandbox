# cif-parser

A minimal-dependency CIF, mmCIF and BinaryCIF reader for the browser and web workers. It works on bytes, can stream, and exposes data as columns. The design follows `whitepapers/mmcif-parser.md`.

Status: **tokenizer only**. The category and column layer, BinaryCIF decoding and the mmCIF-to-`MolScene` loader come next.

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
