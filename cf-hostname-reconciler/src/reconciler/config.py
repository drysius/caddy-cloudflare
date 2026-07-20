"""Configuration loaded from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass


class ConfigError(RuntimeError):
    pass


def _bool(name: str, default: bool = False) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


def _num(name: str, default, cast):
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return cast(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be a {cast.__name__}, got {raw!r}") from exc


def _csv(name: str, default: str = "") -> tuple[str, ...]:
    return tuple(s.strip().lower() for s in os.environ.get(name, default).split(",") if s.strip())


@dataclass(frozen=True)
class Config:
    cf_api_token: str
    # Zones to manage, in priority order. Empty means "every zone the token can see".
    # The first entry is the default target for newly created custom hostnames.
    cf_domains: tuple[str, ...] = ()
    internal_suffixes: tuple[str, ...] = ()
    zone_cache_ttl: int = 900
    reconcile_interval: int = 3600
    debounce_seconds: float = 5.0
    max_deletions_per_run: int = 5
    max_deletion_ratio: float = 0.3
    dry_run: bool = False
    log_level: str = "INFO"
    log_format: str = "text"
    health_port: int = 8080
    cf_api_base: str = "https://api.cloudflare.com/client/v4"

    @classmethod
    def from_env(cls) -> Config:
        token = os.environ.get("CF_API_TOKEN", "").strip()
        if not token:
            raise ConfigError(
                "Missing required environment variable CF_API_TOKEN. "
                "The token needs 'Zone:Read' (zone discovery) and "
                "'SSL and Certificates:Edit' on every managed zone."
            )

        suffixes = tuple(s if s.startswith(".") else "." + s for s in _csv("INTERNAL_SUFFIXES"))

        return cls(
            cf_api_token=token,
            cf_domains=_csv("CF_DOMAINS"),
            internal_suffixes=suffixes,
            zone_cache_ttl=_num("ZONE_CACHE_TTL", 900, int),
            reconcile_interval=_num("RECONCILE_INTERVAL", 3600, int),
            debounce_seconds=_num("DEBOUNCE_SECONDS", 5.0, float),
            max_deletions_per_run=_num("MAX_DELETIONS_PER_RUN", 5, int),
            max_deletion_ratio=_num("MAX_DELETION_RATIO", 0.3, float),
            dry_run=_bool("DRY_RUN", False),
            log_level=os.environ.get("LOG_LEVEL", "INFO").strip().upper(),
            log_format=os.environ.get("LOG_FORMAT", "text").strip().lower(),
            health_port=_num("HEALTH_PORT", 8080, int),
            cf_api_base=os.environ.get(
                "CF_API_BASE", "https://api.cloudflare.com/client/v4"
            ).strip().rstrip("/"),
        )
