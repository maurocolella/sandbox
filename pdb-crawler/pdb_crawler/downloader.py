from __future__ import annotations

import asyncio
import os
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, List, Optional

import aiofiles
import aiohttp
from time import monotonic


DOWNLOAD_BASE = "https://files.rcsb.org/download"


@dataclass
class DownloadConfig:
    base_url: str = DOWNLOAD_BASE
    timeout_seconds: float = 60.0
    max_retries: int = 5
    backoff_base: float = 0.5
    backoff_max: float = 15.0
    initial_jitter_max: float = 0.75  # seconds


def _default_concurrency() -> int:
    try:
        import multiprocessing

        cores = max(1, multiprocessing.cpu_count())
    except Exception:
        cores = 1
    # Use up to 50% of cores by default, at least 1
    return max(1, cores // 2)


async def _sleep_with_jitter(base: float) -> None:
    jitter = base * 0.1 * random.random()
    await asyncio.sleep(base + jitter)


async def _download_one(
    session: aiohttp.ClientSession,
    out_dir: Path,
    entry_id: str,
    file_format: str,
    cfg: DownloadConfig,
    sem: asyncio.Semaphore,
    on_event: Optional[Callable[[dict], None]],
) -> Optional[Path]:
    ext = "cif" if file_format.lower() == "cif" else "pdb"
    url = f"{cfg.base_url}/{entry_id}.{ext}"
    target = out_dir / f"{entry_id}.{ext}"

    # Skip if exists
    if target.exists() and target.stat().st_size > 0:
        if on_event is not None:
            on_event({
                "event": "download_skip",
                "id": entry_id,
                "path": str(target),
                "reason": "exists"
            })
        return target

    async with sem:
        start_ts = monotonic()
        attempt = 0
        last_error: Optional[dict] = None
        while True:
            try:
                async with session.get(url) as resp:
                    if resp.status == 200:
                        data = await resp.read()
                        target.parent.mkdir(parents=True, exist_ok=True)
                        async with aiofiles.open(target, "wb") as f:
                            await f.write(data)
                        if on_event is not None:
                            on_event({
                                "event": "download_ok",
                                "id": entry_id,
                                "path": str(target),
                                "size_bytes": len(data),
                                "attempts": attempt + 1,
                                "elapsed_ms": int((monotonic() - start_ts) * 1000)
                            })
                        return target

                    if resp.status == 429:
                        retry_after = resp.headers.get("Retry-After")
                        if retry_after:
                            try:
                                delay = min(cfg.backoff_max, float(retry_after))
                            except ValueError:
                                delay = min(cfg.backoff_max, cfg.backoff_base * (2 ** attempt))
                        else:
                            delay = min(cfg.backoff_max, cfg.backoff_base * (2 ** attempt))
                        last_error = {"status": resp.status, "reason": "rate_limited"}
                        await _sleep_with_jitter(delay)
                        attempt += 1
                        if attempt > cfg.max_retries:
                            if on_event is not None:
                                on_event({
                                    "event": "download_error",
                                    "id": entry_id,
                                    "path": str(target),
                                    "status": resp.status,
                                    "reason": "rate_limited",
                                    "attempts": attempt,
                                    "elapsed_ms": int((monotonic() - start_ts) * 1000)
                                })
                            return None
                        continue

                    if 500 <= resp.status < 600:
                        # Server error, backoff and retry
                        delay = min(cfg.backoff_max, cfg.backoff_base * (2 ** attempt))
                        last_error = {"status": resp.status, "reason": "server_error"}
                        await _sleep_with_jitter(delay)
                        attempt += 1
                        if attempt > cfg.max_retries:
                            if on_event is not None:
                                on_event({
                                    "event": "download_error",
                                    "id": entry_id,
                                    "path": str(target),
                                    "status": resp.status,
                                    "reason": "server_error",
                                    "attempts": attempt,
                                    "elapsed_ms": int((monotonic() - start_ts) * 1000)
                                })
                            return None
                        continue

                    # 4xx other than 429 or any unexpected
                    if on_event is not None:
                        on_event({
                            "event": "download_error",
                            "id": entry_id,
                            "path": str(target),
                            "status": resp.status,
                            "reason": "client_error",
                            "attempts": attempt + 1,
                            "elapsed_ms": int((monotonic() - start_ts) * 1000)
                        })
                    return None
            except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                if attempt >= cfg.max_retries:
                    if on_event is not None:
                        on_event({
                            "event": "download_error",
                            "id": entry_id,
                            "path": str(target),
                            "reason": type(e).__name__,
                            "attempts": attempt + 1,
                            "elapsed_ms": int((monotonic() - start_ts) * 1000)
                        })
                    return None
                delay = min(cfg.backoff_max, cfg.backoff_base * (2 ** attempt))
                await _sleep_with_jitter(delay)
                attempt += 1


async def download_entries(
    entry_ids: Iterable[str],
    out_dir: str | os.PathLike[str],
    file_format: str = "pdb",
    concurrency: Optional[int] = None,
    cfg: Optional[DownloadConfig] = None,
    on_event: Optional[Callable[[dict], None]] = None,
) -> List[Path]:
    """Download files for given IDs in parallel.

    Returns list of successfully written file paths.
    """
    ids = [i.strip() for i in entry_ids if i and i.strip()]
    if not ids:
        return []

    fmt = file_format.lower()
    if fmt not in {"cif", "pdb"}:
        raise ValueError("file_format must be 'cif' or 'pdb'")

    c = max(1, int(concurrency)) if concurrency and concurrency > 0 else _default_concurrency()
    cfg = cfg or DownloadConfig()

    out_path = Path(out_dir)
    timeout = aiohttp.ClientTimeout(total=cfg.timeout_seconds)

    sem = asyncio.Semaphore(c)
    connector = aiohttp.TCPConnector(limit=c)

    # Initial small stagger
    initial_jitter = min(cfg.initial_jitter_max, cfg.initial_jitter_max * random.random())

    async with aiohttp.ClientSession(timeout=timeout, connector=connector) as session:
        await asyncio.sleep(initial_jitter)
        tasks = [
            asyncio.create_task(_download_one(session, out_path, eid, fmt, cfg, sem, on_event))
            for eid in ids
        ]
        results = await asyncio.gather(*tasks)

    return [p for p in results if p is not None]
