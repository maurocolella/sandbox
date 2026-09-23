# mol-crawler

Async crawler for PDB archive entries (via RCSB) to:

- Count total entries
- Enumerate entry IDs (paginated)
- Sample an n% subset of IDs
- Download corresponding PDB/mmCIF files (plain or gzipped) in parallel with robust backoff, optionally paced

## Features

- Modern Python (3.11+), Poetry packaging
- Async HTTP via `aiohttp`
- Parallelism default: 50% of available CPU cores (configurable)
- Graceful handling of 429/5xx with exponential backoff and jitter, honoring `Retry-After`
- Streams downloads to `*.part` files (renamed when complete), so large entries (1 GB+) use constant memory and interrupted runs never leave truncated files
- `--max-rate` caps total bandwidth across all connections (e.g. `2M` = 2 MB/s), to stay gentle on shared networks
- CLI powered by Typer; thin CLI over reusable library (`mol_crawler`)
- Vetted RCSB query JSONs under `mol_crawler/queries/`

## Install

```bash
poetry install
```

## Quickstart

```bash
# From repo root
cd mol-crawler
poetry install

# Count total entries
poetry run mol-crawler count

# Enumerate all IDs into ./ids.txt (comma-separated)
poetry run mol-crawler list-ids --out ids.txt

# Sample 5% (deterministic with seed)
poetry run mol-crawler sample --ids ids.txt --percent 5 --out sample_ids.txt --seed 42

# Fetch PDB files in parallel into ./downloads (auto concurrency)
poetry run mol-crawler fetch --ids sample_ids.txt --out ./downloads --concurrency auto

# Full pipeline with 5%
poetry run mol-crawler run-all --percent 5 --out-dir ./downloads --work-dir ./output
```

## CLI

```bash
poetry run mol-crawler --help
```

### Commands

- `count` — Fetch total count of entries
- `list-ids` — Enumerate all entry IDs and save to a text file (CSV of IDs)
- `sample` — Randomly sample an n% subset of IDs
- `fetch` — Download files for a list of IDs
- `run-all` — Count → list IDs → sample → fetch (convenience)

Examples:

```bash
# Count
poetry run mol-crawler count

# Enumerate all IDs into ids.txt
poetry run mol-crawler list-ids --out ids.txt

# Sample 5% of IDs into sample_ids.txt (reproducible with a seed)
poetry run mol-crawler sample --ids ids.txt --percent 5 --out sample_ids.txt --seed 42

# Fetch CIFs for sampled IDs into ./downloads
poetry run mol-crawler fetch --ids sample_ids.txt --out ./downloads --format cif --concurrency auto

# Gzipped mmCIF, 2 connections, capped at 2 MB/s total (how fixtures/cif is populated from mol-harness/corpus/tricky.tsv)
poetry run mol-crawler fetch --ids ../fixtures/cif/ids.txt --out ../fixtures/cif --format cif.gz --concurrency 2 --max-rate 2M

# Full pipeline with 5%
poetry run mol-crawler run-all --percent 5 --out-dir ./downloads --work-dir ./work
```

## Programmatic use

```python
from mol_crawler.rcsb_client import RCSBClient
from mol_crawler.sampling import sample_ids
from mol_crawler.downloader import download_entries

# Count
async with RCSBClient() as client:
    total = await client.count_entries()

# Enumerate
async with RCSBClient() as client:
    ids = [id async for id in client.enumerate_entry_ids(page_size=1000)]

# Sample
subset = sample_ids(ids, percent=5.0, seed=42)

# Download
# await download_entries(subset, out_dir="./downloads", file_format="cif")

## Queries

- Stored under `mol_crawler/queries/` and used as templates; code adjusts pagination.

## Notes

- Default endpoints:
  - Search: https://search.rcsb.org/rcsbsearch/v2/query?json
  - Downloads: https://files.rcsb.org/download/{id}.{ext}
- Default format is PDB (`.pdb`). To download mmCIF instead, pass `--format cif`.
