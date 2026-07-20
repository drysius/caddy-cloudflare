"""Thin Cloudflare API client: zone discovery + custom hostname CRUD."""

from __future__ import annotations

import logging
import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import httpx

log = logging.getLogger(__name__)

MAX_ATTEMPTS = 5
BACKOFF_BASE = 1.5


class CloudflareError(RuntimeError):
    pass


@dataclass(frozen=True)
class Zone:
    id: str
    name: str


@dataclass(frozen=True)
class CustomHostname:
    id: str
    hostname: str
    zone_id: str
    zone_name: str
    status: str = ""


class CloudflareClient:
    def __init__(self, token: str, base_url: str, timeout: float = 30.0) -> None:
        self._client = httpx.Client(
            base_url=base_url,
            timeout=timeout,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> CloudflareClient:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        last_error: Exception | None = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                resp = self._client.request(method, path, **kwargs)
            except httpx.HTTPError as exc:
                last_error = exc
            else:
                if resp.status_code == 429 or resp.status_code >= 500:
                    # Honour Retry-After when Cloudflare sends it, else exponential backoff.
                    retry_after = resp.headers.get("Retry-After")
                    delay = (
                        float(retry_after)
                        if retry_after and retry_after.isdigit()
                        else BACKOFF_BASE**attempt
                    )
                    last_error = CloudflareError(f"{resp.status_code} on {method} {path}")
                    log.warning(
                        "cloudflare throttled/errored, retrying",
                        extra={
                            "status": resp.status_code,
                            "attempt": attempt,
                            "delay": delay,
                            "path": path,
                        },
                    )
                    if attempt < MAX_ATTEMPTS:
                        time.sleep(delay)
                    continue

                try:
                    body = resp.json()
                except ValueError as exc:
                    raise CloudflareError(
                        f"non-JSON response from {method} {path}: {resp.text[:200]}"
                    ) from exc

                if not body.get("success", False):
                    raise CloudflareError(
                        f"{method} {path} failed: {body.get('errors')}"
                    )
                return body

            if attempt < MAX_ATTEMPTS:
                time.sleep(BACKOFF_BASE**attempt)

        raise CloudflareError(f"{method} {path} failed after {MAX_ATTEMPTS} attempts: {last_error}")

    def _paginate(
        self, path: str, params: dict[str, Any] | None = None
    ) -> Iterator[dict[str, Any]]:
        page = 1
        while True:
            merged = {**(params or {}), "page": page, "per_page": 50}
            body = self._request("GET", path, params=merged)
            results = body.get("result") or []
            yield from results
            info = body.get("result_info") or {}
            total_pages = info.get("total_pages") or 1
            if page >= total_pages or not results:
                return
            page += 1

    def verify_token(self) -> None:
        self._request("GET", "/user/tokens/verify")

    def list_zones(self, names: tuple[str, ...] = ()) -> list[Zone]:
        if names:
            zones = []
            for name in names:
                found = list(self._paginate("/zones", {"name": name}))
                if not found:
                    raise CloudflareError(f"zone {name!r} not found or not visible to this token")
                zones.extend(Zone(id=z["id"], name=z["name"].lower()) for z in found)
            return zones
        return [Zone(id=z["id"], name=z["name"].lower()) for z in self._paginate("/zones")]

    def list_custom_hostnames(self, zone: Zone) -> list[CustomHostname]:
        return [
            CustomHostname(
                id=item["id"],
                hostname=item["hostname"].lower().rstrip("."),
                zone_id=zone.id,
                zone_name=zone.name,
                status=item.get("status", ""),
            )
            for item in self._paginate(f"/zones/{zone.id}/custom_hostnames")
        ]

    def create_custom_hostname(self, zone: Zone, hostname: str) -> CustomHostname:
        body = self._request(
            "POST",
            f"/zones/{zone.id}/custom_hostnames",
            json={"hostname": hostname, "ssl": {"method": "http", "type": "dv"}},
        )
        result = body["result"]
        return CustomHostname(
            id=result["id"],
            hostname=result["hostname"].lower(),
            zone_id=zone.id,
            zone_name=zone.name,
            status=result.get("status", ""),
        )

    def delete_custom_hostname(self, entry: CustomHostname) -> None:
        self._request("DELETE", f"/zones/{entry.zone_id}/custom_hostnames/{entry.id}")
