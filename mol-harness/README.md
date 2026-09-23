# mol-harness

Corpus-scale validation for the structure loaders. It parses every entry harvested by `mol-crawler` and checks the results for semantic sanity. Today it covers `pdb-parser`. The mmCIF and BinaryCIF loaders, and the checks between formats (PDB vs mmCIF twins, text vs BinaryCIF), belong here too; see `whitepapers/mmcif-parser.md` §8.

```sh
pnpm --filter mol-harness test:pdb                    # all .pdb files under ../fixtures/pdb
PDB_FIXTURES=/path/to/pdb pnpm --filter mol-harness test:pdb
BULK_WORKERS=8 BULK_HEUR_CHUNK_SIZE=5000 pnpm --filter mol-harness test:pdb
```

It uses the built parser (`pdb-parser/dist`), so build that first: `pnpm --filter pdb-parser build`.

## Layout

- `tests/`: corpus-scale tests.
  - `pdb-bulk.spec.ts`: parses every harvested `.pdb` file.
  - `cif-document.spec.ts`: rebuilds every gemmi expectation (rows, models, altlocs, elements, label and author chains, insertion codes, microheterogeneity, struct_conn by type, secondary structure, entities, branches, assemblies, operators) from `cif-parser`'s column layer, and checks that eager and lazy decoding agree.
  - `cif-load.spec.ts`: loads every corpus entry to a `MolScene` and checks it against the gemmi expectations. It also compares the mmCIF loader with the PDB loader on the 300 twins in `fixtures/cif/twins/` (fetched from the `fixtures/pdb` IDs): atoms, coordinates, elements, chains, residues, backbone and secondary structure must all match.
  - `cif-tokenize.spec.ts`: checks the `cif-parser` tokenizer against gemmi on the syntax cases, and streams every `fixtures/cif` entry through gunzip. It compares `_atom_site` row counts with the expectations, and token-stream hashes across whole-buffer and chunked input. Run it with `pnpm --filter mol-harness test:cif`; add `CIF_GIANTS=1` to include 36ZA, 9FQR and 8GLV.
- `corpus/tricky.tsv`: verified tricky entries with the property each one exercises. It lists IDs only; fetch the files with `mol-crawler`.
- `corpus/expectations/*.json`: gemmi-recorded expectations for each tricky entry (gemmi 0.7.5), the oracle loader tests compare against. The fixtures themselves live in the gitignored `../fixtures/cif/` (43 entries, 609 MB gzipped); see the `mol-crawler` README for the fetch command.
- `fixtures/cif-syntax/cases.json`: CIF edge-case inputs with gemmi's reading as the reference. Our tolerant parser deliberately differs in places, so tests say so explicitly.
- `fixtures/producers/`: 4HHB as written by third-party mmCIF writers (Biopython, biotite, gemmi, OpenMM, python-modelcif), gzipped. These pin each writer's deviations.
- `tools/` (Python; `pip install -r tools/requirements.txt`, where gemmi alone covers the oracle and syntax tools):
  - `gemmi_expect.py`: records expectations per file (atom counts, models, altlocs, asyms, microheterogeneity, struct_conn by type, secondary structure, entities, assemblies) as JSON, the oracle for loader tests.
  - `syntax_cases.py`: regenerates `cases.json`.
  - `gen_producer_fixtures.py`: regenerates the producer fixtures; the output is byte-identical with the tool versions it lists.
- `scratch/` (gitignored): working material, such as the mmCIF research artifacts in `scratch/research-2026-09/`.
