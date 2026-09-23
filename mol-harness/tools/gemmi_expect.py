"""Record gemmi-derived expectations for mmCIF files as JSON (the oracle for loader tests).

Usage: python gemmi_expect.py FILE.cif[.gz] ... > expectations.json
       python gemmi_expect.py --out-dir ../corpus/expectations FILE.cif[.gz] ...   (one ID.json per file)
Requires gemmi (tested with 0.7.5). Memory is roughly 10x the uncompressed file (36ZA needs ~12 GB).
"""
import collections
import json
import sys

import gemmi

ATOM_COLS = ["label_alt_id", "label_comp_id", "label_asym_id", "auth_asym_id", "label_seq_id",
             "auth_seq_id", "pdbx_PDB_ins_code", "type_symbol", "pdbx_PDB_model_num", "label_atom_id"]


def is_null(v):
    return v in (".", "?")


def expect(path):
    block = gemmi.cif.read(path).sole_block()
    # gemmi needs a required first tag; every other column is optional ('?' prefix)
    rows = block.find("_atom_site.", ["Cartn_x"] + ["?" + c for c in ATOM_COLS])
    col = {c: i + 1 for i, c in enumerate(ATOM_COLS)}

    def get(r, c):
        return r[col[c]] if r.has(col[c]) else "?"

    models = collections.Counter()
    alts, elems = collections.Counter(), collections.Counter()
    label_asyms, auth_asyms = set(), set()
    ins_atoms = 0
    residues = collections.defaultdict(set)  # (model, asym, seq) -> comp_ids, polymer residues only
    for r in rows:
        models[get(r, "pdbx_PDB_model_num")] += 1
        alt = get(r, "label_alt_id")
        if not is_null(alt):
            alts[alt] += 1
        elems[get(r, "type_symbol")] += 1
        label_asyms.add(get(r, "label_asym_id"))
        auth_asyms.add(get(r, "auth_asym_id"))
        if not is_null(get(r, "pdbx_PDB_ins_code")):
            ins_atoms += 1
        seq = get(r, "label_seq_id")
        if not is_null(seq):
            residues[(get(r, "pdbx_PDB_model_num"), get(r, "label_asym_id"), seq)].add(gemmi.cif.as_string(get(r, "label_comp_id")))

    def count_of(tag):
        return len(block.find_values(tag))

    return {
        "file": path.rsplit("/", 1)[-1],
        "gemmiVersion": gemmi.__version__,
        "atomSiteRows": len(rows),
        "models": dict(models),
        "altlocs": dict(alts),
        "elements": dict(elems),
        "labelAsymCount": len(label_asyms),
        "authAsymCount": len(auth_asyms),
        "insertionCodeAtoms": ins_atoms,
        "microheterogeneousPositions": sum(1 for v in residues.values() if len(v) > 1),
        "structConnByType": dict(collections.Counter(block.find_values("_struct_conn.conn_type_id"))),
        "structConfRows": count_of("_struct_conf.id"),
        "sheetRangeRows": count_of("_struct_sheet_range.id"),
        "entityTypes": dict(collections.Counter(block.find_values("_entity.type"))),
        "branchSchemeRows": count_of("_pdbx_branch_scheme.asym_id"),
        "assemblies": count_of("_pdbx_struct_assembly.id"),
        "operators": count_of("_pdbx_struct_oper_list.id"),
    }


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["--out-dir"]:
        out_dir, paths = args[1], args[2:]
        for p in paths:
            name = p.rsplit("/", 1)[-1].split(".cif")[0]
            with open(f"{out_dir}/{name}.json", "w") as fh:
                json.dump(expect(p), fh, indent=1, sort_keys=True)
                fh.write("\n")
    else:
        json.dump([expect(p) for p in args], sys.stdout, indent=1, sort_keys=True)
        sys.stdout.write("\n")
