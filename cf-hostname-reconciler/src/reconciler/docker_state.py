"""Desired state: hostnames declared in `caddy_*` labels of running containers."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

import docker
from docker.errors import DockerException

log = logging.getLogger(__name__)

# Only the site-block keys (`caddy`, `caddy_0`, `caddy_1`), not sub-directives
# like `caddy_1.reverse_proxy`.
SITE_BLOCK_KEY = re.compile(r"^caddy(_\d+)?$")
SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*://")

# Optional per-container hint telling which Cloudflare zone owns these hostnames.
ZONE_LABEL = "cf_zone"


class DockerUnavailableError(RuntimeError):
    pass


@dataclass(frozen=True)
class DesiredHostname:
    hostname: str
    zone_hint: str = ""
    container: str = ""


def _normalize(raw: str) -> str | None:
    host = raw.strip().lower()
    if not host:
        return None
    host = SCHEME.sub("", host)
    host = host.split("/", 1)[0]
    # Strip the port, but leave IPv6 literals alone (they are rejected below anyway).
    if ":" in host and not host.startswith("["):
        host = host.split(":", 1)[0]
    return host.rstrip(".") or None


def is_managed(host: str, internal_suffixes: tuple[str, ...]) -> bool:
    if "{{" in host or "{" in host:  # unresolved template
        return False
    if host.startswith("*.") or "*" in host:
        return False
    if "." not in host:  # catch-all site block such as `https://`
        return False
    return not any(host == s.lstrip(".") or host.endswith(s) for s in internal_suffixes)


def parse_label_value(value: str, internal_suffixes: tuple[str, ...]) -> list[str]:
    """Extract managed hostnames from one `caddy_*` label value."""
    hosts = []
    for chunk in value.split(","):
        host = _normalize(chunk)
        if host and is_managed(host, internal_suffixes):
            hosts.append(host)
    return hosts


def desired_from_labels(
    labels: dict[str, str], internal_suffixes: tuple[str, ...], container: str = ""
) -> list[DesiredHostname]:
    zone_hint = (labels.get(ZONE_LABEL) or "").strip().lower()
    out: list[DesiredHostname] = []
    for key, value in labels.items():
        if not SITE_BLOCK_KEY.match(key):
            continue
        for host in parse_label_value(value, internal_suffixes):
            out.append(DesiredHostname(hostname=host, zone_hint=zone_hint, container=container))
    return out


class DockerState:
    def __init__(self, client: docker.DockerClient | None = None) -> None:
        self._client = client

    @property
    def client(self) -> docker.DockerClient:
        if self._client is None:
            try:
                self._client = docker.from_env()
            except DockerException as exc:
                raise DockerUnavailableError(f"cannot reach the Docker socket: {exc}") from exc
        return self._client

    def desired(self, internal_suffixes: tuple[str, ...]) -> dict[str, DesiredHostname]:
        """Map hostname -> desired entry for every running container.

        Raises DockerUnavailableError so the caller can trip the safety latch instead of
        mistaking an unreadable socket for "no hostnames wanted".
        """
        try:
            containers = self.client.containers.list(filters={"status": "running"})
        except DockerException as exc:
            raise DockerUnavailableError(f"failed to list containers: {exc}") from exc

        found: dict[str, DesiredHostname] = {}
        for container in containers:
            labels = container.labels or {}
            for entry in desired_from_labels(labels, internal_suffixes, container.name):
                # First container wins; a later one cannot silently retarget the zone.
                found.setdefault(entry.hostname, entry)
        return found
