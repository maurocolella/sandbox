import { describe, it, expect } from "vitest";
import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { createGunzip, gunzipSync } from "node:zlib";
import { join } from "node:path";
import { CifTokenizer, Tok } from "cif-parser";

const HARNESS = join(__dirname, "..");
const CIF_FIXTURES = process.env.CIF_FIXTURES || join(HARNESS, "..", "fixtures", "cif");
const GIANTS = new Set(["36ZA", "9FQR", "8GLV"]); // run with CIF_GIANTS=1

// --- Syntax cases vs gemmi --------------------------------------------------------------------------

interface GemmiItem { tag?: string; raw: string | string[]; loop?: string[] }
interface GemmiResult { ok: boolean; error?: string; blocks?: { name: string; items: GemmiItem[] }[] }
const cases = JSON.parse(readFileSync(join(HARNESS, "fixtures", "cif-syntax", "cases.json"), "utf8")) as {
  gemmiVersion: string;
  cases: Record<string, { input: string; gemmi: GemmiResult }>;
};

/** gemmi keeps raw tokens; convert to the unquoted value our tokenizer reports. */
function gemmiValue(raw: string): string {
  if (raw.startsWith(";") && /\r?\n;$/.test(raw)) return raw.slice(1).replace(/\r?\n;$/, ""); // text field (a bare value may also start with ';')
  if ((raw.startsWith("'") || raw.startsWith('"')) && raw.length >= 2) return raw.slice(1, -1);
  return raw;
}

/** Flatten gemmi's structure into the token sequence a CIF tokenizer must produce. */
function gemmiTokens(r: GemmiResult): string[] {
  const out: string[] = [];
  for (const b of r.blocks ?? []) {
    out.push(`Data:${b.name.trim()}`);
    for (const it of b.items) {
      if (it.loop) {
        out.push("Loop");
        for (const t of it.loop) out.push(`Tag:${t}`);
        for (const v of it.raw as string[]) out.push(`Value:${gemmiValue(v)}`);
      } else {
        out.push(`Tag:${it.tag}`, `Value:${gemmiValue(it.raw as string)}`);
      }
    }
  }
  return out;
}

function ourTokens(input: string): { toks: string[]; warnings: string[] } {
  const tz = CifTokenizer.of(new TextEncoder().encode(input));
  const toks: string[] = [];
  for (let k = tz.next(); k !== Tok.Eof; k = tz.next()) {
    if (k === Tok.Data) toks.push(`Data:${tz.text()}`);
    else if (k === Tok.Loop) toks.push("Loop");
    else if (k === Tok.Tag) toks.push(`Tag:${tz.text()}`);
    else if (k === Tok.Value) toks.push(`Value:${tz.text()}`);
    else toks.push(Object.keys(Tok).find((n) => Tok[n as keyof typeof Tok] === k)!);
  }
  return { toks, warnings: tz.warnings.map((w) => w.code) };
}

// Where gemmi reports an error (a spec violation), the tokenizer's lenient reading is pinned here.
// Structural errors (empty loops, wrong value counts, reserved words as values, duplicates) are the
// parser's to report, so at token level they tokenize normally.
const LENIENT: Record<string, { toks: string[]; warning?: string }> = {
  text_close_nows: { toks: ["Data:x", "Tag:_a", "Value:abc", "Tag:_b", "Value:1"], warning: "text-field-close-not-followed-by-whitespace" },
  unterminated_text: { toks: ["Data:x", "Tag:_a", "Value:abc"], warning: "unterminated-text-field" },
  quote_eol_unclosed: { toks: ["Data:x", "Tag:_a", "Value:abc", "Tag:_b", "Value:1"], warning: "unterminated-quote" },
  bom: { toks: ["Data:x", "Tag:_a", "Value:1"], warning: "bom" },
  reserved_global: { toks: ["Data:x", "Tag:_a", "Global"] },
  reserved_datalike: { toks: ["Data:x", "Tag:_a", "Data:foo"] },
  dollar_lead: { toks: ["Data:x", "Tag:_a", "Value:$abc"], warning: "reserved-leading-char" },
  case_tags: { toks: ["Data:x", "Tag:_A.B", "Value:1", "Tag:_a.b", "Value:2"] },
  empty_loop: { toks: ["Data:x", "Loop", "Tag:_a.x", "Tag:_a.y", "Tag:_b.z", "Value:1"] },
  loop_bad_count: { toks: ["Data:x", "Loop", "Tag:_a.x", "Tag:_a.y", "Value:1", "Value:2", "Value:3"] },
  missing_value: { toks: ["Data:x", "Tag:_a", "Tag:_b", "Value:1"] },
  dup_tag: { toks: ["Data:x", "Tag:_a", "Value:1", "Tag:_a", "Value:2"] },
};
// gemmi accepts these but reads them differently at token level, by design
const DIVERGES: Record<string, string[]> = {
  stop_: ["Data:x", "Loop", "Tag:_a.x", "Value:1", "Value:2", "Stop", "Tag:_b", "Value:1"], // gemmi consumes stop_
};

describe(`CIF syntax cases vs gemmi ${cases.gemmiVersion}`, () => {
  for (const [name, c] of Object.entries(cases.cases)) {
    it(name, () => {
      const ours = ourTokens(c.input);
      if (c.gemmi.ok && !DIVERGES[name]) {
        expect(ours.toks).toEqual(gemmiTokens(c.gemmi));
      } else {
        const pinned = DIVERGES[name] ? { toks: DIVERGES[name]! } : LENIENT[name];
        expect(pinned, `no pinned expectation for gemmi error: ${c.gemmi.error}`).toBeDefined();
        expect(ours.toks).toEqual(pinned!.toks);
        if ("warning" in pinned! && pinned!.warning) expect(ours.warnings).toContain(pinned!.warning);
      }
    });
  }
});

// --- Real corpus: streamed atom_site row counts vs gemmi expectations ------------------------------

interface Scan { tokens: number; hash: number; atomSiteRows: number; atomSiteTags: number; warnings: string[] }

/** Tokenize a stream of chunks, counting _atom_site rows and hashing the whole token stream. */
function scanner() {
  const tz = new CifTokenizer();
  const st: Scan = { tokens: 0, hash: 0x811c9dc5, atomSiteRows: 0, atomSiteTags: 0, warnings: [] };
  let inLoop = false, readingTags = false, atomLoop = false, loopTags = 0, loopValues = 0;
  const closeLoop = () => {
    if (inLoop && atomLoop) {
      expect(loopValues % loopTags, "atom_site value count must be a multiple of its columns").toBe(0);
      st.atomSiteRows += loopValues / loopTags;
      st.atomSiteTags = loopTags;
    }
    inLoop = false;
  };
  const drain = () => {
    for (;;) {
      const k = tz.next();
      if (k === Tok.NeedMore || k === Tok.Eof) return k;
      st.tokens++;
      let h = Math.imul(st.hash ^ k, 16777619) >>> 0;
      const buf = tz.buffer;
      for (let i = tz.start; i < tz.end; i++) h = Math.imul(h ^ buf[i]!, 16777619) >>> 0;
      st.hash = Math.imul(h ^ (k === Tok.Value ? tz.valueKind : 7), 16777619) >>> 0;

      if (k === Tok.Loop) {
        closeLoop();
        inLoop = readingTags = true;
        atomLoop = false;
        loopTags = loopValues = 0;
      } else if (k === Tok.Tag && inLoop && readingTags) {
        if (loopTags === 0) atomLoop = tz.text().toLowerCase().startsWith("_atom_site.");
        loopTags++;
      } else if (k === Tok.Value && inLoop) {
        readingTags = false;
        loopValues++;
      } else {
        closeLoop(); // a tag after values, or a keyword, ends the loop
      }
    }
  };
  return {
    push(chunk: Uint8Array) { tz.push(chunk); drain(); },
    finish(): Scan { tz.finish(); expect(drain()).toBe(Tok.Eof); closeLoop(); st.warnings = tz.warnings.map((w) => w.code); return st; },
  };
}

async function scanStream(path: string, highWaterMark: number): Promise<Scan> {
  const s = scanner();
  const gunzip = createReadStream(path, { highWaterMark }).pipe(createGunzip({ chunkSize: highWaterMark }));
  for await (const chunk of gunzip) s.push(chunk as Uint8Array);
  return s.finish();
}

const corpus = existsSync(CIF_FIXTURES)
  ? readdirSync(CIF_FIXTURES).filter((f) => f.endsWith(".cif.gz")).sort()
  : [];
const expectation = (id: string) => {
  const p = join(HARNESS, "corpus", "expectations", `${id}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { atomSiteRows: number }) : undefined;
};

describe("tokenizing the tricky corpus (streamed through gunzip)", () => {
  it("has fixtures", () => {
    expect(corpus.length, `no .cif.gz under ${CIF_FIXTURES}; fetch them with mol-crawler`).toBeGreaterThan(0);
  });
  for (const file of corpus) {
    const id = file.replace(/\.cif\.gz$/, "");
    const giant = GIANTS.has(id);
    it.skipIf(giant && !process.env.CIF_GIANTS)(id, async () => {
      const want = expectation(id);
      expect(want, `no expectation for ${id}`).toBeDefined();
      const t0 = performance.now();
      const streamed = await scanStream(join(CIF_FIXTURES, file), 64 * 1024);
      const ms = performance.now() - t0;
      expect(streamed.atomSiteRows).toBe(want!.atomSiteRows);
      if (!giant) {
        // Whole-buffer parse and an odd chunk size must give the identical token stream
        const whole = scanner();
        whole.push(gunzipSync(readFileSync(join(CIF_FIXTURES, file))));
        const w = whole.finish();
        const odd = await scanStream(join(CIF_FIXTURES, file), 4093);
        expect([w.tokens, w.hash]).toEqual([streamed.tokens, streamed.hash]);
        expect([odd.tokens, odd.hash]).toEqual([streamed.tokens, streamed.hash]);
      }
      // eslint-disable-next-line no-console
      console.log(`[cif] ${id}: ${streamed.atomSiteRows} atom rows, ${streamed.tokens} tokens, ${ms.toFixed(0)} ms, warnings ${JSON.stringify([...new Set(streamed.warnings)])}`);
    }, 600_000);
  }
});
