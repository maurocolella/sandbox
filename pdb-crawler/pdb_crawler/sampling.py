from __future__ import annotations

import math
import random
from typing import Iterable, List, Optional, Sequence


def sample_ids(ids: Sequence[str], percent: float, seed: Optional[int] = None) -> List[str]:
    """Return a random sample of IDs sized by percent.

    - If seed is provided, uses deterministic PRNG for reproducibility.
    - If seed is None, uses SystemRandom for higher-quality randomness.
    - Sampling is without replacement.
    - Percent is clamped to [0, 100].
    """
    if not ids:
        return []

    p = max(0.0, min(100.0, float(percent)))
    if p <= 0.0:
        return []

    n = len(ids)
    k = math.floor(n * (p / 100.0))
    k = max(1, min(n, k))

    # Work on a copy
    pool = list(ids)

    rng = random.Random(seed) if seed is not None else random.SystemRandom()

    # If k close to n, shuffle and slice is efficient
    rng.shuffle(pool)
    return pool[:k]
