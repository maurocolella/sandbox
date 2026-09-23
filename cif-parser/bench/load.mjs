// mmCIF -> MolScene: node bench/load.mjs ../fixtures/cif/4HHB.cif.gz [...]
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { loadMmcif } from "../dist/index.js";

for (const path of process.argv.slice(2)) {
  const bytes = gunzipSync(readFileSync(path));
  let s, ms = Infinity;
  for (let run = 0; run < 3; run++) { const t0 = performance.now(); s = loadMmcif(bytes); ms = Math.min(ms, performance.now() - t0); }
  const ss = s.tables.secondary ?? [];
  console.log(`${path.split("/").pop()}: ${ms.toFixed(0)} ms | atoms ${s.atoms.count}, chains ${s.tables.chains.length}, residues ${s.tables.residues.length}, bonds ${s.bonds?.count ?? 0}, helices ${ss.filter((x) => x.kind === "helix").length}, sheets ${ss.filter((x) => x.kind === "sheet").length}, backbone points ${s.backbone?.residueOfPoint.length ?? 0} in ${(s.backbone?.segments.length ?? 0) / 2} segments, models ${s.metadata.modelCount}, id ${s.metadata.pdbId}, warnings ${s.metadata.warnings.length}`);
}
