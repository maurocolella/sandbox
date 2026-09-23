// Tokenizer throughput on decompressed files: node bench/tokenize.mjs ../fixtures/cif/3J3Q.cif.gz [...]
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { CifTokenizer, Tok } from "../dist/index.js";

for (const path of process.argv.slice(2)) {
  const bytes = gunzipSync(readFileSync(path));
  let best = Infinity, tokens = 0;
  for (let run = 0; run < 3; run++) {
    const t0 = performance.now();
    const tz = CifTokenizer.of(bytes);
    let n = 0;
    while (tz.next() !== Tok.Eof) n++;
    best = Math.min(best, performance.now() - t0);
    tokens = n;
  }
  const mb = bytes.length / 1e6;
  console.log(`${path.split("/").pop()}: ${mb.toFixed(0)} MB, ${tokens} tokens, best ${best.toFixed(0)} ms (${(mb / best * 1000).toFixed(0)} MB/s)`);
}
