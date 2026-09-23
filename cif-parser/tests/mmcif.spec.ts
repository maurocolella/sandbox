import { describe, it, expect } from "vitest";
import { loadMmcif } from "../src/index.js";

const enc = new TextEncoder();
const load = (s: string, o = {}) => loadMmcif(enc.encode(s), o);

// Two residues of chain A (GLY, then SER with two conformers), a ligand and a water on auth chain A,
// plus chain B with one residue. Coordinates are chosen so bonds are unambiguous.
const ENTRY = `data_TEST
_entry.id TEST
loop_
_chem_comp_bond.comp_id
_chem_comp_bond.atom_id_1
_chem_comp_bond.atom_id_2
_chem_comp_bond.value_order
GLY N CA sing
GLY CA C sing
GLY C O doub
SER N CA sing
SER CA C sing
SER CA CB sing
SER CB OG sing
loop_
_struct_conf.conf_type_id
_struct_conf.id
_struct_conf.beg_label_asym_id
_struct_conf.beg_label_seq_id
_struct_conf.end_label_asym_id
_struct_conf.end_label_seq_id
HELX_P H1 A 1 A 2
loop_
_struct_conn.id
_struct_conn.conn_type_id
_struct_conn.ptnr1_label_asym_id
_struct_conn.ptnr1_auth_seq_id
_struct_conn.ptnr1_label_atom_id
_struct_conn.ptnr2_label_asym_id
_struct_conn.ptnr2_auth_seq_id
_struct_conn.ptnr2_label_atom_id
_struct_conn.ptnr1_symmetry
_struct_conn.ptnr2_symmetry
covale1 covale A 2 OG C 101 C1 1_555 1_555
metalc1 metalc A 1 O C 101 C2 1_555 1_555
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_alt_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_seq_id
_atom_site.pdbx_PDB_ins_code
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.occupancy
_atom_site.auth_seq_id
_atom_site.auth_asym_id
_atom_site.pdbx_PDB_model_num
ATOM   1 N N   . GLY A 1 ? 0.000 0.000 0.000 1.00 10 A 1
ATOM   2 C CA  . GLY A 1 ? 1.450 0.000 0.000 1.00 10 A 1
ATOM   3 C C   . GLY A 1 ? 2.000 1.400 0.000 1.00 10 A 1
ATOM   4 O O   . GLY A 1 ? 1.300 2.400 0.000 1.00 10 A 1
ATOM   5 N N   . SER A 2 ? 3.300 1.600 0.000 1.00 11 A 1
ATOM   6 C CA  . SER A 2 ? 3.900 2.900 0.000 1.00 11 A 1
ATOM   7 C C   . SER A 2 ? 5.400 2.900 0.000 1.00 11 A 1
ATOM   8 C CB  A SER A 2 ? 3.400 3.700 1.200 0.70 11 A 1
ATOM   9 O OG  A SER A 2 ? 3.900 5.000 1.200 0.70 11 A 1
ATOM  10 C CB  B SER A 2 ? 3.400 3.700 -1.200 0.30 11 A 1
ATOM  11 O OG  B SER A 2 ? 3.900 5.000 -1.200 0.30 11 A 1
HETATM 12 C C1 . LIG C . ? 4.300 6.300 1.200 1.00 101 A 1
HETATM 13 C C2 . LIG C . ? 5.700 6.500 1.200 1.00 101 A 1
HETATM 14 O O  . HOH D . ? 9.000 9.000 9.000 1.00 201 A 1
ATOM  15 N N   . ALA B 1 ? 20.000 0.000 0.000 1.00 1 B 1
ATOM  16 C CA  . ALA B 1 ? 21.450 0.000 0.000 1.00 1 B 1
ATOM  17 N N   . ALA B 1 ? 20.000 0.000 5.000 1.00 1 B 2
`;

const bondSet = (s: ReturnType<typeof load>) => {
  const n = s.atoms.names;
  return new Set(Array.from({ length: s.bonds!.count }, (_, i) => [s.bonds!.indexA[i]!, s.bonds!.indexB[i]!].map((a) => `${s.tables.residues[s.atoms.residueIndex[a]!]!.seq}${n[a]}${s.atoms.serial[a]}`).sort().join("-")));
};

describe("mmCIF loader", () => {
  it("builds author chains, label-based residues, ligand and water residues", () => {
    const s = load(ENTRY);
    expect(s.metadata.pdbId).toBe("TEST");
    expect(s.metadata.modelCount).toBe(2);
    expect(s.tables.chains!.map((c) => c.id)).toEqual(["A", "B"]);
    expect(s.tables.residues!.map((r) => `${r.name}${r.seq}:${r.chain}`)).toEqual(["GLY10:0", "SER11:0", "LIG101:0", "HOH201:0", "ALA1:1"]);
  });

  it("keeps the best-occupancy conformer per residue by default, or everything", () => {
    expect(load(ENTRY).atoms.count).toBe(14); // SER keeps altloc A (0.70), drops B
    expect(load(ENTRY, { altLocPolicy: "all" }).atoms.count).toBe(16);
  });

  it("selects one model (first by default)", () => {
    expect(load(ENTRY, { modelSelection: 2 }).atoms.count).toBe(1);
  });

  it("bonds from templates, polymer links, struct_conn and ligand distance; never across altlocs or to metals", () => {
    const b = bondSet(load(ENTRY, { altLocPolicy: "all" }));
    // templates (GLY, and SER with each conformer bonded to the shared CA)
    const k = (x: string, y: string) => [x, y].sort().join("-");
    for (const [x, y] of [["10N1", "10CA2"], ["10CA2", "10C3"], ["10C3", "10O4"], ["11N5", "11CA6"], ["11CA6", "11CB8"], ["11CA6", "11CB10"], ["11CB8", "11OG9"], ["11CB10", "11OG11"]]) {
      expect(b, `${x}-${y}`).toContain(k(x!, y!));
    }
    expect(b).not.toContain(k("11CB10", "11OG9")); // conformer B's CB never bonds conformer A's OG
    expect(b).toContain(k("10C3", "11N5")); // peptide link
    expect(b).toContain(k("11OG9", "101C112")); // struct_conn covale
    expect(b).toContain(k("101C112", "101C213")); // ligand without template: distance heuristic
    expect([...b].some((x) => x.includes("201O14"))).toBe(false); // water isolated
    expect(b).not.toContain(k("10O4", "101C213")); // metalc is not a covalent bond
  });

  it("reads secondary structure and traces the backbone per label chain", () => {
    const s = load(ENTRY);
    expect(s.tables.secondary).toEqual([{ kind: "helix", chain: 0, startResidue: 0, endResidue: 1 }]);
    expect(s.backbone!.residueOfPoint.length).toBe(2); // GLY, SER (ALA B is a single point, dropped)
    expect(Array.from(s.backbone!.orientation.subarray(0, 3)).some((v) => v !== 0)).toBe(true); // CA->O
  });

  it("loads author-only files (PyMOL/Biopython style) and files without atoms", () => {
    const authOnly = `data_x
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.auth_atom_id
_atom_site.auth_comp_id
_atom_site.auth_asym_id
_atom_site.auth_seq_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
ATOM 1 N GLY A 5 0 0 0
ATOM 2 CA GLY A 5 1.45 0 0
ATOM 3 N GLY A 6 3 0 0
`;
    const s = load(authOnly);
    expect(s.atoms.count).toBe(3);
    expect(s.tables.residues!.map((r) => r.seq)).toEqual([5, 6]);
    expect(Array.from(s.atoms.element)).toEqual([7, 6, 7]); // inferred from atom names
    const empty = load("data_x\n_entry.id x\n");
    expect(empty.atoms.count).toBe(0);
    expect(empty.metadata.warnings.join()).toContain("no _atom_site");
  });
});
