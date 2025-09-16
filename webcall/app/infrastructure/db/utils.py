from __future__ import annotations

from typing import Optional


def safe_like(raw: Optional[str], max_len: int = 100) -> Optional[str]:
    """Prepare a user-provided string for SQL LIKE queries.

    - Trims and lowercases the input.
    - Limits length to `max_len`.
    - Escapes SQL LIKE wildcards '%' and '_' and backslash.
    - Returns pattern string wrapped with leading/trailing '%' or None for empty input.
    """
    if raw is None:
        return None
    s = str(raw).strip().lower()
    if not s:
        return None
    if len(s) > max_len:
        s = s[:max_len]
    # escape backslash first
    s = s.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
    return f"%{s}%"
