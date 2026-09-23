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

# Format name -> file extension on the download server
FORMATS = {"pdb": "pdb", "cif": "cif", "pdb.gz": "pdb.gz", "cif.gz": "cif.gz"}
CHUNK_BYTES = 64 * 1024


@dataclass
class DownloadConfig:
    base_url: str = DOWNLOAD_BASE
    timeout_seconds: float = 60.0  # per socket read, not per file: large files stream for minutes
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


class RateLimiter:
    """Shared bandwidth cap across all downloads (bytes/second); None means unlimited."""

    def __init__(self, bytes_per_second: Optional[float]) -> None:
        self.rate = bytes_per_second if bytes_per_second and bytes_per_second > 0 else None
        self._next_free = monotonic()

    async def consume(self, n: int) -> None:
        if self.rate is None:
            return
        now = monotonic()
        start = max(now, self._next_free)
        self._next_free = start + n / self.rate
        if start > now:
            await asyncio.sleep(start - now)


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
    limiter: RateLimiter,
    on_event: Optional[Callable[[dict], None]],
) -> Optional[Path]:
    ext = FORMATS[file_format]
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
                        # Stream to a .part file (paced by the shared limiter), then rename into place so a
                        # partial download is never mistaken for a complete one by the skip-if-exists check
                        target.parent.mkdir(parents=True, exist_ok=True)
                        part = target.with_name(target.name + ".part")
                        size = 0
                        async with aiofiles.open(part, "wb") as f:
                            async for chunk in resp.content.iter_chunked(CHUNK_BYTES):
                                await limiter.consume(len(chunk))
                                await f.write(chunk)
                                size += len(chunk)
                        os.replace(part, target)
                        if on_event is not None:
                            on_event({
                                "event": "download_ok",
                                "id": entry_id,
                                "path": str(target),
                                "size_bytes": size,
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
    max_bytes_per_second: Optional[float] = None,
) -> List[Path]:
    """Download files for given IDs in parallel, optionally capped to a total bandwidth.

    Returns list of successfully written file paths.
    """
    ids = [i.strip() for i in entry_ids if i and i.strip()]
    if not ids:
        return []

    fmt = file_format.lower()
    if fmt not in FORMATS:
        raise ValueError(f"file_format must be one of {sorted(FORMATS)}")

    c = max(1, int(concurrency)) if concurrency and concurrency > 0 else _default_concurrency()
    cfg = cfg or DownloadConfig()

    out_path = Path(out_dir)
    timeout = aiohttp.ClientTimeout(total=None, sock_connect=30, sock_read=cfg.timeout_seconds)
    limiter = RateLimiter(max_bytes_per_second)

    sem = asyncio.Semaphore(c)
    connector = aiohttp.TCPConnector(limit=c)

    # Initial small stagger
    initial_jitter = min(cfg.initial_jitter_max, cfg.initial_jitter_max * random.random())

    async with aiohttp.ClientSession(timeout=timeout, connector=connector) as session:
        await asyncio.sleep(initial_jitter)
        tasks = [
            asyncio.create_task(_download_one(session, out_path, eid, fmt, cfg, sem, limiter, on_event))
            for eid in ids
        ]
        results = await asyncio.gather(*tasks)

    return [p for p in results if p is not None]
