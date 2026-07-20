"""Zone discovery and target-zone resolution."""

from __future__ import annotations

import logging
import time

from .cloudflare import CloudflareClient, CloudflareError, Zone

log = logging.getLogger(__name__)


class ZoneRegistry:
    """Caches the zone list so every reconcile does not re-list zones."""

    def __init__(
        self,
        client: CloudflareClient,
        names: tuple[str, ...] = (),
        ttl: int = 900,
    ) -> None:
        self._client = client
        self._names = names
        self._ttl = ttl
        self._zones: list[Zone] = []
        self._fetched_at = 0.0

    def zones(self, force: bool = False) -> list[Zone]:
        if force or not self._zones or time.monotonic() - self._fetched_at > self._ttl:
            zones = self._client.list_zones(self._names)
            if not zones:
                raise CloudflareError("token can see no zones; check its Zone:Read permission")
            # CF_DOMAINS order is meaningful (first = default target), so keep it.
            self._zones = zones if self._names else sorted(zones, key=lambda z: z.name)
            self._fetched_at = time.monotonic()
            log.info("zones discovered", extra={"zones": [z.name for z in self._zones]})
        return self._zones

    def zone_names(self) -> tuple[str, ...]:
        return tuple(z.name for z in self.zones())

    def by_name(self, name: str) -> Zone | None:
        name = name.strip().lower()
        return next((z for z in self.zones() if z.name == name), None)

    def target_zone(self, hint: str = "") -> Zone:
        """Zone that should own a newly created custom hostname.

        Resolution order: container `cf_zone` label -> first CF_DOMAINS entry ->
        the single known zone.
        """
        if hint:
            zone = self.by_name(hint)
            if zone:
                return zone
            raise CloudflareError(f"target zone {hint!r} is not among the managed zones")

        zones = self.zones()
        if self._names or len(zones) == 1:
            return zones[0]
        raise CloudflareError(
            "multiple zones are managed but no target zone was given; "
            "set CF_DOMAINS or add a `cf_zone` label to the container"
        )
