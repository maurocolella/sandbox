from __future__ import annotations

import asyncio
import json
import random
from pathlib import Path
from typing import Iterable, List, Optional

import typer
from rich import print

from .downloader import download_entries
from .rcsb_client import RCSBClient
from .sampling import sample_ids

app = typer.Typer(add_completion=False, help="pdb-crawler CLI", rich_markup_mode=None)


def _read_ids_file(path: Path) -> List[str]:
    text = path.read_text(encoding="utf-8")
    # Accept commas, whitespace, and newlines as separators
    raw = [token.strip() for token in text.replace("\n", ",").split(",")]
    return [r for r in raw if r]


def _write_ids_file(path: Path, ids: Iterable[str]) -> None:
    # Write as comma-separated to satisfy requirement
    content = ",".join(ids)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _open_ids_file_for_stream(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    return path.open("w", encoding="utf-8")


def _make_event_emitter(log_file: Optional[Path]):
    f = None
    if log_file is not None:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        f = log_file.open("a", encoding="utf-8")

    def emit(ev: dict) -> None:
        print(ev)
        if f is not None:
            f.write(json.dumps(ev) + "\n")
            f.flush()

    return emit, f


def _parse_concurrency(value: str) -> Optional[int]:
    if value == "auto":
        return None
    try:
        v = int(value)
        return v if v > 0 else None
    except ValueError:
        return None


@app.command()
def count() -> None:
    """Retrieve the total count of entries from RCSB."""
    async def _run() -> None:
        async with RCSBClient() as client:
            total = await client.count_entries()
            print({"total": total})

    asyncio.run(_run())


@app.command("list-ids")
def list_ids(
    out: str = typer.Option("ids.txt", help="Output file for comma-separated IDs"),
    page_size: int = typer.Option(1000, help="Pagination size for enumeration"),
    resume: bool = typer.Option(False, "--resume", "-r", is_flag=True, help="Skip if output already exists and is non-empty"),
    log_file: Optional[str] = typer.Option(None, help="Append JSON events to this file"),
) -> None:
    """Enumerate all entry IDs and write them to a file (comma-separated)."""
    async def _run() -> None:
        out_path = Path(out)
        log_path = Path(log_file) if log_file else None
        emit, fh = _make_event_emitter(log_path)
        if resume and out_path.exists() and out_path.stat().st_size > 0:
            emit({"event": "ids_resume_skip", "file": str(out_path)})
            if fh:
                fh.close()
            return
        async with RCSBClient() as client:
            count = 0
            first = True
            def on_page(start: int, rows: int, page_number: int, total: int) -> None:
                emit({"event": "enumerate_page", "page": page_number, "start": start, "rows": rows, "total": total})
            with _open_ids_file_for_stream(out_path) as f:
                async for eid in client.enumerate_entry_ids(page_size=page_size, on_page=on_page):
                    if first:
                        f.write(eid)
                        first = False
                    else:
                        f.write("," + eid)
                    count += 1
        emit({"written": count, "file": str(out_path)})
        if fh:
            fh.close()

    asyncio.run(_run())


@app.command()
def sample(
    ids: str = typer.Option(..., help="Input file with IDs (comma/newline separated)"),
    percent: float = typer.Option(..., min=0.0, max=100.0, help="Percent of IDs to sample"),
    out: str = typer.Option("sample_ids.txt", help="Output file for sampled IDs (comma-separated)"),
    seed: Optional[int] = typer.Option(None, help="Seed for reproducible sampling; omit for secure random"),
    resume: bool = typer.Option(False, "--resume", "-r", is_flag=True, help="Skip if output already exists and is non-empty"),
    log_file: Optional[str] = typer.Option(None, help="Append JSON events to this file"),
) -> None:
    """Sample an n% subset of IDs and write to file."""
    ids_path = Path(ids)
    out_path = Path(out)
    log_path = Path(log_file) if log_file else None
    emit, fh = _make_event_emitter(log_path)
    if resume and out_path.exists() and out_path.stat().st_size > 0:
        emit({"event": "sample_resume_skip", "file": str(out_path)})
        if fh:
            fh.close()
        return
    id_list = _read_ids_file(ids_path)
    subset = sample_ids(id_list, percent=percent, seed=seed)
    _write_ids_file(out_path, subset)
    emit({"sampled": len(subset), "file": str(out_path)})
    if fh:
        fh.close()


@app.command()
def fetch(
    ids: str = typer.Option(..., help="Input file with IDs (comma/newline separated)"),
    out: str = typer.Option("downloads", help="Output directory for downloads"),
    format: str = typer.Option("pdb", help="File format: cif or pdb"),
    concurrency: str = typer.Option("auto", help="Positive int or 'auto' for 50% cores"),
    resume: bool = typer.Option(False, "--resume", "-r", is_flag=True, help="No effect on existing files (they are always skipped); included for consistency"),
    log_file: Optional[str] = typer.Option(None, help="Append JSON events to this file"),
) -> None:
    """Download PDB/mmCIF files for IDs in parallel with backoff and jitter."""
    async def _run() -> None:
        ids_path = Path(ids)
        out_path = Path(out)
        log_path = Path(log_file) if log_file else None
        emit, fh = _make_event_emitter(log_path)
        id_list = _read_ids_file(ids_path)
        conc = _parse_concurrency(concurrency)
        emit({"event": "download_start", "count": len(id_list), "out_dir": str(out_path), "format": format, "concurrency": ("auto" if conc is None else conc)})
        def on_event(ev: dict) -> None:
            emit(ev)
        paths = await download_entries(id_list, out_dir=out_path, file_format=format, concurrency=conc, on_event=on_event)
        emit({"downloaded": len(paths), "out_dir": str(out_path)})
        if fh:
            fh.close()

    asyncio.run(_run())


@app.command("run-all")
def run_all(
    percent: float = typer.Option(..., min=0.0, max=100.0, help="Percent of IDs to sample"),
    work_dir: str = typer.Option("work", help="Directory for intermediate files"),
    out_dir: str = typer.Option("downloads", help="Output directory for downloads"),
    format: str = typer.Option("pdb", help="File format: cif or pdb"),
    seed: Optional[int] = typer.Option(None, help="Seed for reproducible sampling; omit for secure random"),
    page_size: int = typer.Option(1000, help="Pagination size for enumeration"),
    concurrency: str = typer.Option("auto", help="Positive int or 'auto' for 50% cores"),
    resume: bool = typer.Option(False, "--resume", "-r", is_flag=True, help="Skip steps whose outputs already exist and are non-empty"),
    log_file: Optional[str] = typer.Option(None, help="Append JSON events to this file"),
) -> None:
    """Convenience pipeline: count → list-ids → sample → fetch."""
    async def _run() -> None:
        work = Path(work_dir)
        ids_file = work / "ids.txt"
        sampled_file = work / "sample_ids.txt"
        attempt_file = work / "attempt_ids.txt"

        log_path = Path(log_file) if log_file else None
        emit, fh = _make_event_emitter(log_path)
        async with RCSBClient() as client:
            total = await client.count_entries()
            emit({"total": total})
            # Stream enumeration to file unless resuming and exists
            if resume and ids_file.exists() and ids_file.stat().st_size > 0:
                emit({"event": "ids_resume_skip", "file": str(ids_file)})
            else:
                count = 0
                first = True
                def on_page(start: int, rows: int, page_number: int, total: int) -> None:
                    emit({"event": "enumerate_page", "page": page_number, "start": start, "rows": rows, "total": total})
                with _open_ids_file_for_stream(ids_file) as f:
                    async for eid in client.enumerate_entry_ids(page_size=page_size, on_page=on_page):
                        if first:
                            f.write(eid)
                            first = False
                        else:
                            f.write("," + eid)
                        count += 1
                emit({"ids_written": count, "file": str(ids_file)})

        # Sampling step with resume
        if resume and sampled_file.exists() and sampled_file.stat().st_size > 0:
            emit({"event": "sample_resume_skip", "file": str(sampled_file)})
            subset = _read_ids_file(sampled_file)
        else:
            all_ids = _read_ids_file(ids_file)
            subset = sample_ids(all_ids, percent=percent, seed=seed)
            _write_ids_file(sampled_file, subset)
            emit({"sampled": len(subset), "file": str(sampled_file)})

        # Build or load attempt order; persist it for reproducible resume
        if resume and attempt_file.exists() and attempt_file.stat().st_size > 0:
            attempt_order = _read_ids_file(attempt_file)
            emit({"event": "attempt_resume", "file": str(attempt_file), "count": len(attempt_order)})
        else:
            attempt_order = list(subset)
            _write_ids_file(attempt_file, attempt_order)
            emit({"event": "attempt_init", "file": str(attempt_file), "count": len(attempt_order)})

        conc = _parse_concurrency(concurrency)
        out_path = Path(out_dir)

        # Exact-K successes: count only ok/skip as success. Process in batches to avoid overshoot.
        success_target = len(subset)
        success_count = 0
        idx = 0

        # Preload all_ids for potential top-ups
        all_ids = _read_ids_file(ids_file)
        attempted_set = set(attempt_order)

        def on_event(ev: dict) -> None:
            nonlocal success_count
            emit(ev)
            if ev.get("event") in {"download_ok", "download_skip"}:
                success_count += 1

        while success_count < success_target:
            remaining_needed = success_target - success_count
            remaining_queue = attempt_order[idx:]
            if not remaining_queue:
                # Top-up from remaining universe deterministically if seed provided, else SystemRandom
                remaining_pool = [e for e in all_ids if e not in attempted_set]
                if not remaining_pool:
                    emit({"event": "attempt_exhausted", "attempted": len(attempt_order), "success": success_count, "target": success_target})
                    break
                rng = random.Random(seed) if seed is not None else random.SystemRandom()
                rng.shuffle(remaining_pool)
                topup = remaining_pool[:remaining_needed]
                attempt_order.extend(topup)
                attempted_set.update(topup)
                _write_ids_file(attempt_file, attempt_order)
                emit({"event": "attempt_topup", "added": len(topup), "attempt_total": len(attempt_order)})
                remaining_queue = attempt_order[idx:]

            # Batch at most the exact needed amount to avoid overshoot if all succeed
            batch = remaining_queue[:remaining_needed]
            emit({"event": "download_start", "count": len(batch), "out_dir": str(out_path), "format": format, "concurrency": ("auto" if conc is None else conc)})
            await download_entries(batch, out_dir=out_path, file_format=format, concurrency=conc, on_event=on_event)
            idx += len(batch)

        emit({"event": "download_summary", "success": success_count, "target": success_target, "out_dir": str(out_path)})
        if fh:
            fh.close()

    asyncio.run(_run())


def main() -> None:
    app()


if __name__ == "__main__":
    main()
