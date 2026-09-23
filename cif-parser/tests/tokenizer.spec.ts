import { describe, it, expect } from "vitest";
import { CifTokenizer, Tok, ValueKind, type TokKind } from "../src/index.js";

const enc = new TextEncoder();
const KIND = Object.fromEntries(Object.entries(Tok).map(([k, v]) => [v, k])) as Record<number, string>;

interface T { k: string; v: string; q?: number; line: number }

/** Tokenize, feeding the input in chunks of the given size (0 = whole buffer). */
function tokens(input: string | Uint8Array, chunk = 0): { toks: T[]; tz: CifTokenizer } {
  const bytes = typeof input === "string" ? enc.encode(input) : input;
  const tz = new CifTokenizer();
  const toks: T[] = [];
  const drain = () => {
    for (;;) {
      const k: TokKind = tz.next();
      if (k === Tok.NeedMore || k === Tok.Eof) return k;
      const t: T = { k: KIND[k]!, v: tz.text(), line: tz.line };
      if (k === Tok.Value && tz.valueKind !== ValueKind.Bare) t.q = tz.valueKind;
      toks.push(t);
    }
  };
  if (chunk <= 0) {
    tz.push(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += chunk) {
      tz.push(bytes.subarray(i, i + chunk));
      drain();
    }
  }
  tz.finish();
  expect(drain()).toBe(Tok.Eof);
  return { toks, tz };
}

const vals = (s: string) => tokens(s).toks.map((t) => (t.q !== undefined ? `${t.k}:${t.q}:${t.v}` : `${t.k}:${t.v}`));

describe("CifTokenizer: syntax rules", () => {
  it("reads blocks, tags, pairs and loops", () => {
    expect(vals("data_1CRN\n_entry.id 1CRN\nloop_\n_a.x\n_a.y\n1 2\n3 4\n")).toEqual([
      "Data:1CRN", "Tag:_entry.id", "Value:1CRN", "Loop:", "Tag:_a.x", "Tag:_a.y", "Value:1", "Value:2", "Value:3", "Value:4",
    ].map((s) => s.replace("Loop:", "Loop:loop_")));
  });

  it("closes a quote only when followed by whitespace", () => {
    expect(vals("data_x\n_a 'a dog's life'\n_b \"O5'\"\n")).toEqual(["Data:x", "Tag:_a", "Value:1:a dog's life", "Tag:_b", "Value:2:O5'"]);
  });

  it("keeps quoted '.'/'?' as literals and bare ones as null", () => {
    const tz = CifTokenizer.of(enc.encode("_a '.' _b . _c '?' _d ?"));
    const nulls: boolean[] = [];
    for (let k = tz.next(); k !== Tok.Eof; k = tz.next()) if (k === Tok.Value) nulls.push(tz.isNull());
    expect(nulls).toEqual([false, true, false, true]);
  });

  it("reads text fields: content starts right after ';' and ends before the closing EOL", () => {
    expect(vals("_a\n;\nline1\n  line2  \n;\n")).toEqual(["Tag:_a", "Value:3:\nline1\n  line2  "]);
    expect(vals("_a\n;line1\nline2\n;\n_b 1")).toEqual(["Tag:_a", "Value:3:line1\nline2", "Tag:_b", "Value:1"]);
    expect(vals("_a\r\n;line1\r\nline2\r\n;\r\n")).toEqual(["Tag:_a", "Value:3:line1\r\nline2"]);
  });

  it("treats ';' mid-line and '#' inside bare values as ordinary characters", () => {
    expect(vals("_a ;abc _b ab#c # comment\n_c 1")).toEqual(["Tag:_a", "Value:;abc", "Tag:_b", "Value:ab#c", "Tag:_c", "Value:1"]);
  });

  it("keeps '#' inside quotes and text fields", () => {
    expect(vals("_a 'Water #5'\n_b\n;x # y\n;\n")).toEqual(["Tag:_a", "Value:1:Water #5", "Tag:_b", "Value:3:x # y"]);
  });

  it("recognises keywords case-insensitively, and only as whole words", () => {
    expect(vals("DATA_X LOOP_ _a Save_f save_ loop_x global_ STOP_ data_").map((s) => s.split(":")[0]))
      .toEqual(["Data", "Loop", "Tag", "Save", "SaveEnd", "Value", "Global", "Stop", "Data"]);
  });

  it("reads CIF 1.1 triple quotes as ordinary quoted strings", () => {
    expect(vals("_a '''abc'''")).toEqual(["Tag:_a", "Value:1:''abc''"]);
  });

  it("tracks line numbers across text fields and CRLF", () => {
    const { toks } = tokens("data_x\r\n_a\n;1\n2\n;\n_b 'x'\n");
    expect(toks.map((t) => [t.k, t.line])).toEqual([["Data", 1], ["Tag", 2], ["Value", 3], ["Tag", 6], ["Value", 6]]);
  });

  it("tolerates deviations and records warnings", () => {
    const cases: [string, string, string[]][] = [
      ["﻿data_x\n_a 1\n", "bom", ["Data:x", "Tag:_a", "Value:1"]],
      ["_a 'abc\n_b 1\n", "unterminated-quote", ["Tag:_a", "Value:1:abc", "Tag:_b", "Value:1"]],
      ["_a 'abc'#c\n_b 1\n", "quote-closed-by-hash", ["Tag:_a", "Value:1:abc", "Tag:_b", "Value:1"]],
      ["_a\n;abc\n;_b 1\n", "text-field-close-not-followed-by-whitespace", ["Tag:_a", "Value:3:abc", "Tag:_b", "Value:1"]],
      ["_a\n;abc\n", "unterminated-text-field", ["Tag:_a", "Value:3:abc"]],
      ["_a $abc", "reserved-leading-char", ["Tag:_a", "Value:$abc"]],
      ["#\\#CIF_2.0\ndata_x", "cif2-not-supported", ["Data:x"]],
    ];
    for (const [input, code, expected] of cases) {
      const { tz } = tokens(input);
      expect(vals(input), code).toEqual(expected);
      expect(tz.warnings.map((w) => w.code), input).toContain(code);
    }
  });

  it("accepts a missing final newline and empty input", () => {
    expect(vals("data_x\n_a 1")).toEqual(["Data:x", "Tag:_a", "Value:1"]);
    expect(vals("")).toEqual([]);
    expect(vals("# only a comment")).toEqual([]);
  });
});

// Deterministic PRNG for fuzzing
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

const SAMPLE = [
  "﻿data_1ABC\n# comment\n_struct.title 'It's a \"test\"'\n_a.b ;mid\nloop_\n_x.a _x.b\n",
  "1 'two words'\n\"O5'\" ?\n.\n'.'\n;\ntext # not comment\n  indented\n;\n",
  "_crlf\r\n;l1\r\nl2\r\n;\r\nsave_frame\n_s.t v\nsave_\nglobal_ stop_\n_last 'unterminated\n_q 'x'#c\n_end tail",
].join("");

describe("CifTokenizer: streaming invariance", () => {
  it("produces identical tokens for every chunk size", () => {
    const whole = tokens(SAMPLE).toks;
    expect(whole.length).toBeGreaterThan(25);
    for (const size of [1, 2, 3, 7, 16, 64]) expect(tokens(SAMPLE, size).toks, `chunk ${size}`).toEqual(whole);
  });
});

describe("CifTokenizer: fuzzing", () => {
  const FRAGMENTS = ["data_", "loop_", "save_", "_tag", "_a.b", " ", "\n", "\r\n", "\r", "\t", "'", "\"", ";", "#", "value",
    ".", "?", "'q x'", "\"d\"", "\n;", "\n;\n", "global_", "STOP_", "x'y", "﻿", "1.5e3", "[", "$"];

  it("terminates, stays in bounds and is chunk-invariant on random CIF-like input", () => {
    const rand = rng(42);
    for (let iter = 0; iter < 400; iter++) {
      let s = "";
      const n = 1 + Math.floor(rand() * 60);
      for (let i = 0; i < n; i++) s += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)];
      const bytes = enc.encode(s);
      const whole = tokens(bytes);
      expect(whole.toks.length).toBeLessThanOrEqual(bytes.length + 1);
      const size = 1 + Math.floor(rand() * 9);
      expect(tokens(bytes, size).toks, JSON.stringify(s)).toEqual(whole.toks);
    }
  });

  it("survives random bytes", () => {
    const rand = rng(7);
    for (let iter = 0; iter < 200; iter++) {
      const bytes = new Uint8Array(1 + Math.floor(rand() * 300)).map(() => Math.floor(rand() * 256));
      const whole = tokens(bytes);
      expect(tokens(bytes, 5).toks).toEqual(whole.toks);
    }
  });
});
