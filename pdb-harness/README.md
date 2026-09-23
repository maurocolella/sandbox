# pdb-harness

Corpus-scale validation for the structure loaders. It parses every entry harvested by `pdb-crawler` and checks the results for semantic sanity. Today it covers `pdb-parser`. The mmCIF and BinaryCIF loaders, and the checks between formats (PDB vs mmCIF twins, text vs BinaryCIF), belong here too; see `whitepapers/mmcif-parser.md` §8.

```sh
pnpm --filter pdb-harness test:pdb                    # all .pdb files under ../fixtures/pdb
PDB_FIXTURES=/path/to/pdb pnpm --filter pdb-harness test:pdb
BULK_WORKERS=8 BULK_HEUR_CHUNK_SIZE=5000 pnpm --filter pdb-harness test:pdb
```

It uses the built parser (`pdb-parser/dist`), so build that first: `pnpm --filter pdb-parser build`.

`scratch/` is gitignored and holds working material, such as the mmCIF research artifacts in `scratch/research-2026-09/`.
