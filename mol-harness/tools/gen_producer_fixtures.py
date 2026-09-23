"""Regenerate fixtures/producers/*.cif.gz: 4HHB as written by third-party mmCIF writers.

These pin each tool's deviations from wwPDB output (missing categories, label/auth misuse, reordered
columns, zero occupancies, ...). Committed outputs were made with gemmi 0.7.5, biotite 1.6.0,
Biopython 1.88, OpenMM 8.6.1, python-modelcif 1.8 / python-ihm 2.11.
Usage: python gen_producer_fixtures.py 4hhb.cif 4hhb.pdb ../fixtures/producers
"""
import gzip
import io
import sys
import warnings

warnings.filterwarnings("ignore")


def save(out_dir, name, text):
    with gzip.open(f"{out_dir}/{name}.cif.gz", "wt", compresslevel=9) as fh:
        fh.write(text)


def main(cif_path, pdb_path, out_dir):
    import gemmi
    for name, src in (("gemmi_from_cif", cif_path), ("gemmi_from_pdb", pdb_path)):
        st = gemmi.read_structure(src)
        st.setup_entities()
        save(out_dir, name, st.make_mmcif_document().as_string())
    st = gemmi.read_structure(pdb_path)
    st.setup_entities()
    st.assign_label_seq_id()
    save(out_dir, "gemmi_from_pdb_ids", st.make_mmcif_document().as_string())

    import biotite.structure.io.pdbx as pdbx
    arr = pdbx.get_structure(pdbx.CIFFile.read(cif_path), model=1)
    f = pdbx.CIFFile()
    pdbx.set_structure(f, arr)
    buf = io.StringIO(); f.write(buf); save(out_dir, "biotite", buf.getvalue())

    from openmm.app import PDBFile, PDBxFile
    p = PDBFile(pdb_path)
    buf = io.StringIO(); PDBxFile.writeFile(p.topology, p.positions, buf); save(out_dir, "openmm", buf.getvalue())

    from Bio.PDB import MMCIFIO, MMCIFParser
    s = MMCIFParser(QUIET=True).get_structure("x", cif_path)
    w = MMCIFIO(); w.set_structure(s)
    buf = io.StringIO(); w.save(buf); save(out_dir, "biopython", buf.getvalue())

    # Boltz-style ModelCIF: a tiny model with a 'LIG' ligand, as python-modelcif writes it
    import ihm
    import modelcif
    from modelcif import AsymUnit, Assembly, Entity, System, dumper
    from modelcif.model import AbInitioModel, Atom, ModelGroup
    system = System()
    pep = Entity([ihm.LPeptideAlphabet()[c] for c in "GA"])
    lig = Entity([ihm.NonPolymerChemComp(id="LIG")])
    a = AsymUnit(pep, id="A", details="Model subunit A")
    b = AsymUnit(lig, id="B", details="Model subunit B")

    class Model(AbInitioModel):
        def get_atoms(self):
            yield Atom(asym_unit=a, type_symbol="N", seq_id=1, atom_id="N", x=1, y=2, z=3, biso=91.2, occupancy=1)
            yield Atom(asym_unit=b, type_symbol="C", seq_id=1, atom_id="C1", x=4, y=5, z=6, biso=80.0, occupancy=1, het=True)

    system.model_groups.append(ModelGroup([Model(assembly=Assembly([a, b]), name="Model")]))
    ihm.dumper.set_line_wrap(False)
    buf = io.StringIO(); dumper.write(buf, [system]); save(out_dir, "modelcif_boltzlike", buf.getvalue())


if __name__ == "__main__":
    main(*sys.argv[1:4])
