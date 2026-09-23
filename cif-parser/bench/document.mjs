// Index + atom_site column decode: node bench/document.mjs ../fixtures/cif/3J3Q.cif.gz [...]
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseCif } from "../dist/index.js";

const SPEC = {
  x: { field: "Cartn_x", type: "f32" }, y: { field: "Cartn_y", type: "f32" }, z: { field: "Cartn_z", type: "f32" },
  occ: { field: "occupancy", type: "f32" }, b: { field: "B_iso_or_equiv", type: "f32" },
  id: { field: "id", type: "i32" }, seq: { field: "label_seq_id", type: "i32" }, authSeq: { field: "auth_seq_id", type: "i32" },
  model: { field: "pdbx_PDB_model_num", type: "i32" },
  element: { field: "type_symbol", type: "str" }, atom: { field: "label_atom_id", type: "str" }, comp: { field: "label_comp_id", type: "str" },
  asym: { field: "label_asym_id", type: "str" }, authAsym: { field: "auth_asym_id", type: "str" }, alt: { field: "label_alt_id", type: "str" },
  ins: { field: "pdbx_PDB_ins_code", type: "str" }, entity: { field: "label_entity_id", type: "str" }, group: { field: "group_PDB", type: "str" },
};
for (const path of process.argv.slice(2)) {
  const bytes = gunzipSync(readFileSync(path));
  let bestIndex = Infinity, bestDecode = Infinity, rows = 0, cols = 0;
  for (let run = 0; run < 3; run++) {
    const t0 = performance.now();
    const doc = parseCif(bytes);
    const t1 = performance.now();
    const site = doc.blocks[0].category("atom_site");
    const out = site.decodeColumns(SPEC);
    const t2 = performance.now();
    bestIndex = Math.min(bestIndex, t1 - t0); bestDecode = Math.min(bestDecode, t2 - t1);
    rows = site.rowCount; cols = Object.keys(out).length;
  }
  console.log(`${path.split("/").pop()}: ${(bytes.length / 1e6).toFixed(0)} MB, ${rows} atoms; index ${bestIndex.toFixed(0)} ms, decode ${cols} columns ${bestDecode.toFixed(0)} ms, total ${(bestIndex + bestDecode).toFixed(0)} ms`);
  let bestEager = Infinity;
  for (let run = 0; run < 3; run++) {
    const t0 = performance.now();
    const doc = parseCif(bytes, { decode: { atom_site: SPEC } });
    bestEager = Math.min(bestEager, performance.now() - t0);
    if (Object.keys(doc.blocks[0].category("atom_site").decoded).length !== cols) throw new Error("eager decode incomplete");
  }
  console.log(`  eager (index + decode in one pass): ${bestEager.toFixed(0)} ms`);
}
