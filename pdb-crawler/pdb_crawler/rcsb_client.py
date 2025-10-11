from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import AsyncIterator, Dict, Optional, Callable

import aiohttp
from importlib import resources


SEARCH_ENDPOINT = "https://search.rcsb.org/rcsbsearch/v2/query?json"


def _load_query_json(name: str) -> Dict:
    with resources.files("pdb_crawler.queries").joinpath(name).open("r", encoding="utf-8") as f:
        return json.load(f)


@dataclass
class RCSBClientConfig:
    base_search_url: str = SEARCH_ENDPOINT
    timeout_seconds: float = 30.0
    max_retries: int = 5
    backoff_base: float = 0.5
    backoff_max: float = 10.0


class RCSBClient:
    """Async client for RCSB search API.

    Provides methods to count total entries and enumerate entry IDs with pagination.
    """

    def __init__(self, config: Optional[RCSBClientConfig] = None, session: Optional[aiohttp.ClientSession] = None) -> None:
        self.config = config or RCSBClientConfig()
        self._external_session = session
        self._session: Optional[aiohttp.ClientSession] = None

    async def __aenter__(self) -> "RCSBClient":
        if self._external_session is not None:
            self._session = self._external_session
        else:
            timeout = aiohttp.ClientTimeout(total=self.config.timeout_seconds)
            self._session = aiohttp.ClientSession(timeout=timeout)
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self._external_session is None and self._session:
            await self._session.close()
        self._session = None

    @property
    def session(self) -> aiohttp.ClientSession:
        if self._session is None:
            raise RuntimeError("Client session is not initialized. Use 'async with RCSBClient()' or call 'await __aenter__()'.")
        return self._session

    async def _post_with_retry(self, payload: Dict) -> Dict:
        attempt = 0
        while True:
            try:
                async with self.session.post(self.config.base_search_url, json=payload) as resp:
                    if resp.status == 200:
                        return await resp.json()
                    # Handle 429 with Retry-After if present
                    if resp.status == 429:
                        retry_after = resp.headers.get("Retry-After")
                        if retry_after:
                            try:
                                delay = min(self.config.backoff_max, float(retry_after))
                            except ValueError:
                                delay = min(self.config.backoff_max, self.config.backoff_base * (2 ** attempt))
                        else:
                            delay = min(self.config.backoff_max, self.config.backoff_base * (2 ** attempt))
                        await asyncio.sleep(delay + (delay * 0.1))
                        attempt += 1
                        if attempt > self.config.max_retries:
                            text = await resp.text()
                            raise RuntimeError(f"RCSB search API rate-limited (429) after retries: {text}")
                        continue
                    # For 5xx, backoff via raising and catching ClientError
                    if 500 <= resp.status < 600:
                        raise aiohttp.ClientResponseError(
                            request_info=resp.request_info,
                            history=resp.history,
                            status=resp.status,
                            message=f"Server error {resp.status}",
                            headers=resp.headers,
                        )
                    text = await resp.text()
                    raise RuntimeError(f"RCSB search API error {resp.status}: {text}")
            except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                if attempt >= self.config.max_retries:
                    raise
                delay = min(self.config.backoff_max, self.config.backoff_base * (2 ** attempt))
                # Add jitter
                await asyncio.sleep(delay + (delay * 0.1))
                attempt += 1

    async def count_entries(self) -> int:
        """Return the total count of PDB entries matching the catch-all query."""
        payload = _load_query_json("count_all.json")
        data = await self._post_with_retry(payload)
        # Try multiple possible keys for resilience
        total = data.get("total_count")
        if total is None:
            # Some responses may put total in 'total'
            total = data.get("total")
        if total is None:
            # As a fallback, infer from pagination meta if present
            total = data.get("response", {}).get("numFound")
        if total is None:
            raise RuntimeError("Unable to determine total count from RCSB response")
        return int(total)

    async def enumerate_entry_ids(
        self,
        page_size: int = 1000,
        on_page: Optional[Callable[[int, int, int, int], None]] = None,
    ) -> AsyncIterator[str]:
        """Yield all entry IDs using paginated search queries.

        Args:
            page_size: rows per page (RCSB permits 1000 typical; adjust if needed)
            on_page: optional callback called per page with (start, rows, page_number, total)
        """
        if page_size <= 0:
            raise ValueError("page_size must be positive")

        # First request to get total
        total = await self.count_entries()
        start = 0
        while start < total:
            page_number = (start // page_size) + 1
            payload = _load_query_json("enumerate_all.json")
            # Modify pagination per page
            payload.setdefault("request_options", {}).setdefault("paginate", {})
            payload["request_options"]["paginate"]["start"] = start
            payload["request_options"]["paginate"]["rows"] = min(page_size, total - start)

            if on_page is not None:
                on_page(start, payload["request_options"]["paginate"]["rows"], page_number, total)

            data = await self._post_with_retry(payload)
            result_set = data.get("result_set") or data.get("resultSet") or []
            if not result_set:
                # No more results
                break

            for item in result_set:
                # Typical shape: {"identifier": "1ABC", ...}
                ident = item.get("identifier") or item.get("entry_id") or item.get("id")
                if isinstance(ident, str):
                    yield ident

            start += page_size
