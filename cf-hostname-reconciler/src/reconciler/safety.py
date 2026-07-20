"""Safety latch guarding the deletion phase.

Additions are never blocked; only deletions can be vetoed.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class LatchDecision:
    blocked: bool
    reason: str = ""


def evaluate(
    *,
    desired_count: int,
    delete_count: int,
    actual_count: int,
    docker_ok: bool,
    max_deletions: int,
    max_ratio: float,
) -> LatchDecision:
    if not docker_ok:
        return LatchDecision(True, "docker state unavailable; refusing to delete anything")
    if desired_count == 0:
        return LatchDecision(True, "desired hostname set is empty; refusing to delete anything")
    if delete_count == 0:
        return LatchDecision(False)
    if delete_count > max_deletions:
        return LatchDecision(
            True, f"{delete_count} deletions exceed MAX_DELETIONS_PER_RUN={max_deletions}"
        )
    if actual_count and (delete_count / actual_count) > max_ratio:
        return LatchDecision(
            True,
            f"{delete_count}/{actual_count} deletions exceed MAX_DELETION_RATIO={max_ratio}",
        )
    return LatchDecision(False)
