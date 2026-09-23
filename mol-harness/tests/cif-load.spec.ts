import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { loadMmcif } from "cif-parser";
import { parsePdbToMolScene, type MolScene } from "pdb-parser";

// MolScene tables/metadata are optional in the type; both loaders always fill them
const chainsOf = (s: MolScene) => s.tables?.chains ?? [];
const residuesOf = (s: MolScene) => s.tables?.residues ?? [];
const secondaryOf = (s: MolScene) => s.tables?.secondary ?? [];
const tracePoints = (s: MolScene) => s.backbone?.residueOfPoint?.length ?? 0;

const HARNESS = join(__dirname, "..");
const FIXTURES = join(HARNESS, "..", "fixtures");
const CIF_FIXTURES = process.env.CIF_FIXTURES || join(FIXTURES, "cif");
const TWINS = join(CIF_FIXTURES, "twins");
const PDB_FIXTURES = process.env.PDB_FIXTURES || join(FIXTURES, "pdb");
const GIANTS = new Set(["36ZA", "9FQR", "8GLV"]); // run with CIF_GIANTS=1
// mmCIF re-released after the PDB fixture was downloaded (2026-08 metalloprotein remediation)
const VERSION_DRIFT = new Set(["4W96"]);

const gz = (p: string) => gunzipSync(readFileSync(p));

describe("mmCIF loader on the tricky corpus", () => {
  const files = existsSync(CIF_FIXTURES) ? readdirSync(CIF_FIXTURES).filter((f) => f.endsWith(".cif.gz")).sort() : [];
  it("has fixtures", () => expect(files.length, `fetch fixtures with mol-crawler into ${CIF_FIXTURES}`).toBeGreaterThan(0));
  for (const file of files) {
    const id = file.replace(/\.cif\.gz$/, "");
    it.skipIf(GIANTS.has(id) && !process.env.CIF_GIANTS)(id, () => {
      const want = JSON.parse(readFileSync(join(HARNESS, "corpus", "expectations", `${id}.json`), "utf8"));
      const t0 = performance.now();
      const s = loadMmcif(gz(join(CIF_FIXTURES, file)), { altLocPolicy: "all" });
      const ms = performance.now() - t0;
      const modelKeys = Object.keys(want.models as Record<string, number>).map(Number).sort((a, b) => a - b);
      const firstModel = modelKeys[0];
      expect(s.atoms.count).toBe(firstModel === undefined ? 0 : want.models[String(firstModel)]);
      if (modelKeys.length === 1) expect(chainsOf(s).length).toBe(want.authAsymCount);
      if (s.atoms.count > 0) expect(residuesOf(s).length).toBeGreaterThan(0);
      expect(secondaryOf(s).length).toBeLessThanOrEqual(want.structConfRows + want.sheetRangeRows);
      // eslint-disable-next-line no-console
      console.log(`[cif-load] ${id}: ${ms.toFixed(0)} ms, ${s.atoms.count} atoms, ${residuesOf(s).length} residues, ${s.bonds?.count ?? 0} bonds, ${secondaryOf(s).length} SS spans`);
    }, 600_000);
  }
});

describe("mmCIF vs PDB loader on twin entries", () => {
  const ids = existsSync(TWINS) ? readdirSync(TWINS).filter((f) => f.endsWith(".cif.gz")).map((f) => f.replace(/\.cif\.gz$/, "")).sort() : [];
  it.skipIf(ids.length === 0)("agree on atoms, coordinates, elements, chains, residues, backbone and secondary structure", () => {
    const mismatches: string[] = [];
    let bondsC = 0, bondsP = 0, compared = 0;
    for (const id of ids) {
      if (VERSION_DRIFT.has(id) || !existsSync(join(PDB_FIXTURES, `${id}.pdb`))) continue;
      const c = loadMmcif(gz(join(TWINS, `${id}.cif.gz`)), { altLocPolicy: "all" });
      const p = parsePdbToMolScene(readFileSync(join(PDB_FIXTURES, `${id}.pdb`), "utf8"), {
        altLocPolicy: "all",
        bondPolicy: "conect+heuristic",
        ...((c.metadata?.modelCount ?? 1) > 1 ? { modelSelection: 1 } : {}),
      });
      compared++;
      const diff = (what: string, a: unknown, b: unknown) => { if (a !== b) mismatches.push(`${id} ${what}: ${a} vs ${b}`); };
      diff("atoms", c.atoms.count, p.atoms.count);
      if (c.atoms.count !== p.atoms.count) continue;
      let far = 0;
      for (let i = 0; i < c.atoms.positions.length; i++) if (Math.abs(c.atoms.positions[i]! - p.atoms.positions[i]!) > 1e-3) far++;
      diff("coordinates off", far, 0);
      diff("elements", c.atoms.element!.join(), p.atoms.element!.join());
      diff("chains", chainsOf(c).map((x) => x.id).join(), chainsOf(p).map((x) => x.id).join());
      diff("residues", residuesOf(c).length, residuesOf(p).length);
      diff("backbone points", tracePoints(c), tracePoints(p));
      diff("secondary spans", secondaryOf(c).length, secondaryOf(p).length);
      bondsC += c.bonds?.count ?? 0;
      bondsP += p.bonds?.count ?? 0;
    }
    // Bonds differ by design: the PDB heuristic also bonds across altlocs, to metals and some non-bonded
    // contacts; mmCIF uses the file's chemistry. Reported, not asserted.
    // eslint-disable-next-line no-console
    console.log(`[twins] compared ${compared}; bonds mmCIF ${bondsC} vs PDB ${bondsP} (${((bondsC / bondsP - 1) * 100).toFixed(1)}%)`);
    expect(compared).toBeGreaterThan(0);
    expect(mismatches).toEqual([]);
  }, 1_800_000);
});
