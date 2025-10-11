# pdb-crawler

Async crawler for RCSB PDB to:

- Count total entries
- Enumerate entry IDs (paginated)
- Sample an n% subset of IDs
- Download corresponding PDB/mmCIF files in parallel with robust backoff

## Features

- Modern Python (3.11+), Poetry packaging
- Async HTTP via `aiohttp`
- Parallelism default: 50% of available CPU cores (configurable)
- Graceful handling of 429/5xx with exponential backoff and jitter, honoring `Retry-After`
- CLI powered by Typer; thin CLI over reusable library (`pdb_crawler`)
- Vetted RCSB query JSONs under `pdb_crawler/queries/`

## Install

```bash
poetry install
```

## Quickstart

```bash
# From repo root
cd pdb-crawler
poetry install

# Count total entries
poetry run pdb-crawler count

# Enumerate all IDs into ./ids.txt (comma-separated)
poetry run pdb-crawler list-ids --out ids.txt

# Sample 5% (deterministic with seed)
poetry run pdb-crawler sample --ids ids.txt --percent 5 --out sample_ids.txt --seed 42

# Fetch PDB files in parallel into ./downloads (auto concurrency)
poetry run pdb-crawler fetch --ids sample_ids.txt --out ./downloads --concurrency auto

# Full pipeline with 5%
poetry run pdb-crawler run-all --percent 5 --out-dir ./downloads --work-dir ./output
```

## CLI

```bash
poetry run pdb-crawler --help
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
poetry run pdb-crawler count

# Enumerate all IDs into ids.txt
poetry run pdb-crawler list-ids --out ids.txt

# Sample 5% of IDs into sample_ids.txt (reproducible with a seed)
poetry run pdb-crawler sample --ids ids.txt --percent 5 --out sample_ids.txt --seed 42

# Fetch CIFs for sampled IDs into ./downloads
poetry run pdb-crawler fetch --ids sample_ids.txt --out ./downloads --format cif --concurrency auto

# Full pipeline with 5%
poetry run pdb-crawler run-all --percent 5 --out-dir ./downloads --work-dir ./work
```

## Programmatic use

```python
from pdb_crawler.rcsb_client import RCSBClient
from pdb_crawler.sampling import sample_ids
from pdb_crawler.downloader import download_entries

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

- Stored under `pdb_crawler/queries/` and used as templates; code adjusts pagination.

## Notes

- Default endpoints:
  - Search: https://search.rcsb.org/rcsbsearch/v2/query?json
  - Downloads: https://files.rcsb.org/download/{id}.{ext}
- Default format is PDB (`.pdb`). To download mmCIF instead, pass `--format cif`.
