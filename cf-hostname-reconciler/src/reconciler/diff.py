"""Bidirectional diff between desired labels and actual Cloudflare custom hostnames."""

from __future__ import annotations

from dataclasses import dataclass, field

from .cloudflare import CustomHostname
from .docker_state import DesiredHostname


@dataclass(frozen=True)
class Plan:
    to_create: list[DesiredHostname] = field(default_factory=list)
    to_delete: list[CustomHostname] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not self.to_create and not self.to_delete


def build_plan(
    desired: dict[str, DesiredHostname], actual: list[CustomHostname]
) -> Plan:
    actual_by_host = {entry.hostname: entry for entry in actual}

    to_create = [entry for host, entry in sorted(desired.items()) if host not in actual_by_host]
    to_delete = [
        entry for host, entry in sorted(actual_by_host.items()) if host not in desired
    ]
    unchanged = sorted(set(desired) & set(actual_by_host))
    return Plan(to_create=to_create, to_delete=to_delete, unchanged=unchanged)
