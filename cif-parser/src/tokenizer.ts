/**
 * CIF 1.1 tokenizer over bytes (see whitepapers/mmcif-parser.md §3 and §6).
 *
 * - Scans a Uint8Array directly: no per-token strings, no whole-file string (files can exceed V8's
 *   ~512 MB string limit). A token is a kind plus [start, end) byte offsets into `buffer`, quotes stripped.
 * - Resumable: push() chunks as they arrive, then finish(). next() returns Tok.NeedMore when a token may
 *   continue in the next chunk; a whole-file parse is a single push() + finish(), so streaming and
 *   non-streaming inputs run the same code and produce identical tokens.
 * - Context-free: keywords (data_, loop_, ...) are reported as such wherever they appear; deciding that
 *   `_a data_x` is an error is the parser's job.
 * - Lenient where real files deviate, recording a warning instead of failing.
 */

export const Tok = {
  NeedMore: 0, // feed more input (or call finish()) and call next() again
  Eof: 1,
  Data: 2, // data_NAME: [start, end) is NAME (may be empty)
  Save: 3, // save_NAME: [start, end) is NAME
  SaveEnd: 4, // bare save_
  Loop: 5,
  Stop: 6, // reserved in CIF; used by STAR/NMR-STAR
  Global: 7, // reserved in CIF; used by Refmac monomer libraries
  Tag: 8, // [start, end) includes the leading '_'
  Value: 9,
} as const;
export type TokKind = (typeof Tok)[keyof typeof Tok];

export const ValueKind = {
  Bare: 0,
  SingleQuoted: 1,
  DoubleQuoted: 2,
  TextField: 3, // content after the opening ';' up to (excluding) the EOL before the closing ';'
} as const;
export type ValueKindType = (typeof ValueKind)[keyof typeof ValueKind];

export type WarningCode =
  | "bom"
  | "cif2-not-supported"
  | "unterminated-quote"
  | "unterminated-text-field"
  | "quote-closed-by-hash"
  | "text-field-close-not-followed-by-whitespace"
  | "reserved-leading-char";

export interface TokenizerWarning {
  code: WarningCode;
  line: number; // 1-based
  offset: number; // absolute byte offset in the input stream
}

const LF = 10, CR = 13, SP = 32, HT = 9, HASH = 35, SQ = 39, DQ = 34, SEMI = 59, UNDERSCORE = 95;
const DOLLAR = 36, LBRACKET = 91, RBRACKET = 93;
const MAX_WARNINGS = 1000;

const isWs = (b: number) => b === SP || b === LF || b === CR || b === HT;

export class CifTokenizer {
  /** Current buffer; token offsets index into it and stay valid until the next push(). */
  buffer: Uint8Array = new Uint8Array(0);
  kind: TokKind = Tok.NeedMore;
  start = 0;
  end = 0;
  valueKind: ValueKindType = ValueKind.Bare;
  /** Raw extent of the current token including quotes / text-field delimiters (for re-tokenizing ranges). */
  rawStart = 0;
  rawEnd = 0;
  /** Line (1-based) where the current token starts. */
  line = 1;
  /** True when the input declares CIF 2.0 (not supported yet; tokenized with CIF 1.1 rules). */
  cif2 = false;
  readonly warnings: TokenizerWarning[] = [];
  warningCount = 0;

  private len = 0;
  private pos = 0;
  private base = 0; // absolute offset of buffer[0]
  private final = false;
  private bol = true; // at the start of a line (a ';' here opens a text field)
  private curLine = 1;
  private started = false;

  /** Append input. Offsets of the last token become invalid. */
  push(chunk: Uint8Array): void {
    if (this.final) throw new Error("push() after finish()");
    const rest = this.len - this.pos;
    if (rest === 0) {
      this.base += this.len;
      this.buffer = chunk;
    } else {
      const merged = new Uint8Array(rest + chunk.length);
      merged.set(this.buffer.subarray(this.pos, this.len), 0);
      merged.set(chunk, rest);
      this.base += this.pos;
      this.buffer = merged;
    }
    this.len = this.buffer.length;
    this.pos = 0;
  }

  /** Signal end of input. */
  finish(): void {
    this.final = true;
  }

  /** Tokenize a complete buffer. */
  static of(bytes: Uint8Array): CifTokenizer {
    const t = new CifTokenizer();
    t.push(bytes);
    t.finish();
    return t;
  }

  /**
   * Tokenize bytes [start, end) of an already-indexed buffer, resuming mid-file: the line number is given,
   * and whether `start` is at a line start is inferred from the preceding byte (so a mid-line ';' stays a
   * bare value). No BOM or magic-header handling.
   */
  static range(bytes: Uint8Array, start: number, end: number, line: number): CifTokenizer {
    const t = new CifTokenizer();
    t.buffer = bytes;
    t.len = end;
    t.pos = start;
    t.final = true;
    t.started = true;
    t.curLine = line;
    t.bol = start === 0 || bytes[start - 1] === LF || bytes[start - 1] === CR;
    return t;
  }

  /** Absolute byte offset (in the whole input) of a position in the current buffer. */
  absolute(offset: number): number {
    return this.base + offset;
  }

  /** Unquoted '.' or '?' (inapplicable / unknown). Quoted '.'/'?' are literal strings. */
  isNull(): boolean {
    if (this.kind !== Tok.Value || this.valueKind !== ValueKind.Bare || this.end - this.start !== 1) return false;
    const b = this.buffer[this.start];
    return b === 46 || b === 63;
  }

  /** Current token's bytes decoded as a string (tags, names, values). */
  text(): string {
    return decodeBytes(this.buffer, this.start, this.end);
  }

  next(): TokKind {
    const buf = this.buffer, len = this.len, final = this.final;
    let pos = this.pos;

    if (!this.started) {
      // BOM and CIF 2.0 magic are only meaningful at the very start of the input
      if (len < 10 && !final) return this.needMore(pos);
      if (len >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        this.warn("bom", 0);
        pos = 3;
      }
      if (startsWith(buf, pos, len, "#\\#CIF_2.0")) {
        this.cif2 = true;
        this.warn("cif2-not-supported", pos);
      }
      this.started = true;
    }

    // Skip whitespace and comments
    while (pos < len) {
      const c = buf[pos]!;
      if (c === LF) { this.curLine++; this.bol = true; pos++; continue; }
      if (c === CR) {
        if (pos + 1 >= len && !final) return this.needMore(pos); // might be CRLF split across chunks
        if (buf[pos + 1] === LF) pos++;
        this.curLine++; this.bol = true; pos++; continue;
      }
      if (c === SP || c === HT) { this.bol = false; pos++; continue; }
      if (c === HASH) {
        let q = pos + 1;
        while (q < len && buf[q] !== LF && buf[q] !== CR) q++;
        if (q >= len && !final) return this.needMore(pos);
        pos = q;
        continue;
      }
      break;
    }
    if (pos >= len) {
      if (!final) return this.needMore(pos);
      this.pos = pos;
      this.start = this.end = pos;
      return (this.kind = Tok.Eof);
    }

    const s = pos;
    const c = buf[s]!;
    this.line = this.curLine;
    this.rawStart = s;

    // Text field: ';' in column 1
    if (c === SEMI && this.bol) {
      let q = s + 1;
      let lines = 0;
      for (;;) {
        while (q < len && buf[q] !== LF && buf[q] !== CR) q++;
        if (q >= len) {
          if (!final) return this.needMore(s);
          this.warn("unterminated-text-field", s);
          return this.emitValue(s + 1, len, len, ValueKind.TextField, lines);
        }
        const eol = q;
        if (buf[q] === CR) {
          if (q + 1 >= len && !final) return this.needMore(s);
          q += buf[q + 1] === LF ? 2 : 1;
        } else {
          q++;
        }
        lines++;
        if (q >= len) {
          if (!final) return this.needMore(s);
          this.warn("unterminated-text-field", s);
          return this.emitValue(s + 1, eol, len, ValueKind.TextField, lines);
        }
        if (buf[q] === SEMI) {
          const after = q + 1;
          if (after >= len && !final) return this.needMore(s);
          if (after < len && !isWs(buf[after]!)) this.warn("text-field-close-not-followed-by-whitespace", q);
          return this.emitValue(s + 1, eol, after, ValueKind.TextField, lines);
        }
      }
    }

    // Quoted string: closes at a matching quote followed by whitespace or EOF (CIF 1.1 ¶15)
    if (c === SQ || c === DQ) {
      let q = s + 1;
      for (;;) {
        if (q >= len) {
          if (!final) return this.needMore(s);
          this.warn("unterminated-quote", s);
          return this.emitValue(s + 1, len, len, c === SQ ? ValueKind.SingleQuoted : ValueKind.DoubleQuoted, 0);
        }
        const b = buf[q]!;
        if (b === LF || b === CR) {
          // Unclosed at end of line: take the rest of the line (Mol* behaviour; gemmi errors)
          this.warn("unterminated-quote", s);
          return this.emitValue(s + 1, q, q, c === SQ ? ValueKind.SingleQuoted : ValueKind.DoubleQuoted, 0);
        }
        if (b === c) {
          if (q + 1 >= len) {
            if (!final) return this.needMore(s);
            break;
          }
          const n = buf[q + 1]!;
          if (isWs(n)) break;
          if (n === HASH) { this.warn("quote-closed-by-hash", q); break; } // gemmi accepts this too
        }
        q++;
      }
      return this.emitValue(s + 1, q, q + 1, c === SQ ? ValueKind.SingleQuoted : ValueKind.DoubleQuoted, 0);
    }

    // Bare token: tag, keyword or unquoted value
    let q = s + 1;
    while (q < len && !isWs(buf[q]!)) q++;
    if (q >= len && !final) return this.needMore(s);
    this.pos = q;
    this.bol = false;
    this.start = s;
    this.end = q;
    this.rawEnd = q;
    this.valueKind = ValueKind.Bare;
    if (c === UNDERSCORE) return (this.kind = Tok.Tag);

    const n = q - s;
    if (n >= 5 && buf[s + 4] === UNDERSCORE) {
      const a = buf[s]! | 0x20, b = buf[s + 1]! | 0x20, d = buf[s + 2]! | 0x20, e = buf[s + 3]! | 0x20;
      if (a === 100 && b === 97 && d === 116 && e === 97) { this.start = s + 5; return (this.kind = Tok.Data); } // data_
      if (a === 115 && b === 97 && d === 118 && e === 101) { // save_
        if (n === 5) return (this.kind = Tok.SaveEnd);
        this.start = s + 5;
        return (this.kind = Tok.Save);
      }
      if (n === 5 && a === 108 && b === 111 && d === 111 && e === 112) return (this.kind = Tok.Loop); // loop_
      if (n === 5 && a === 115 && b === 116 && d === 111 && e === 112) return (this.kind = Tok.Stop); // stop_
    }
    if (n === 7 && buf[s + 6] === UNDERSCORE && lowerEquals(buf, s, "global")) return (this.kind = Tok.Global);
    if (c === DOLLAR || c === LBRACKET || c === RBRACKET) this.warn("reserved-leading-char", s);
    return (this.kind = Tok.Value);
  }

  private emitValue(start: number, end: number, next: number, vk: ValueKindType, lines: number): TokKind {
    this.start = start;
    this.end = end;
    this.rawEnd = next;
    this.valueKind = vk;
    this.pos = next;
    this.curLine += lines;
    this.bol = false;
    return (this.kind = Tok.Value);
  }

  private needMore(resumeAt: number): TokKind {
    this.pos = resumeAt;
    return (this.kind = Tok.NeedMore);
  }

  private warn(code: WarningCode, offset: number): void {
    this.warningCount++;
    if (this.warnings.length < MAX_WARNINGS) this.warnings.push({ code, line: this.curLine, offset: this.base + offset });
  }
}

function startsWith(buf: Uint8Array, at: number, len: number, ascii: string): boolean {
  if (at + ascii.length > len) return false;
  for (let i = 0; i < ascii.length; i++) if (buf[at + i] !== ascii.charCodeAt(i)) return false;
  return true;
}

function lowerEquals(buf: Uint8Array, at: number, lowerAscii: string): boolean {
  for (let i = 0; i < lowerAscii.length; i++) if ((buf[at + i]! | 0x20) !== lowerAscii.charCodeAt(i)) return false;
  return true;
}

const utf8 = new TextDecoder("utf-8");

/** Decode a byte range: short ASCII directly, anything else through TextDecoder (UTF-8). */
export function decodeBytes(buf: Uint8Array, start: number, end: number): string {
  const n = end - start;
  if (n <= 64) {
    let s = "";
    for (let i = start; i < end; i++) {
      const b = buf[i]!;
      if (b >= 0x80) return utf8.decode(buf.subarray(start, end));
      s += String.fromCharCode(b);
    }
    return s;
  }
  return utf8.decode(buf.subarray(start, end));
}
