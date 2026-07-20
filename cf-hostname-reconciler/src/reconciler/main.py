"""Entrypoint: event-driven + interval reconciliation loop."""

from __future__ import annotations

import logging
import signal
import sys
import threading
import time

from docker.errors import DockerException

from .cloudflare import CloudflareClient, CloudflareError, CustomHostname
from .config import Config, ConfigError
from .diff import Plan, build_plan
from .docker_state import DockerState, DockerUnavailableError
from .health import HealthState, start_health_server
from .logging_setup import setup_logging
from .safety import evaluate
from .zones import ZoneRegistry

log = logging.getLogger("reconciler")

WATCHED_EVENTS = {"start", "die", "destroy", "update"}


class Reconciler:
    def __init__(
        self,
        config: Config,
        cf: CloudflareClient,
        zones: ZoneRegistry,
        docker_state: DockerState,
        health: HealthState,
    ) -> None:
        self.config = config
        self.cf = cf
        self.zones = zones
        self.docker = docker_state
        self.health = health
        self._lock = threading.Lock()

    def internal_suffixes(self) -> tuple[str, ...]:
        """Configured suffixes plus every managed zone name.

        Hostnames inside your own zones are plain DNS records, never custom hostnames.
        """
        zone_suffixes = tuple(f".{name}" for name in self.zones.zone_names())
        return self.config.internal_suffixes + zone_suffixes

    def actual(self) -> list[CustomHostname]:
        entries: list[CustomHostname] = []
        for zone in self.zones.zones():
            entries.extend(self.cf.list_custom_hostnames(zone))
        return entries

    def run_once(self) -> None:
        with self._lock:
            self._run_once()

    def _run_once(self) -> None:
        started = time.time()
        self.health.update(last_run_ts=started, latch_tripped=False, latch_reason="")

        try:
            suffixes = self.internal_suffixes()
            self.health.update(zones=list(self.zones.zone_names()))
        except CloudflareError as exc:
            log.error("zone discovery failed", extra={"error": str(exc)})
            self.health.bump(errors=1)
            self.health.update(last_error=str(exc))
            return

        docker_ok = True
        try:
            desired = self.docker.desired(suffixes)
        except DockerUnavailableError as exc:
            docker_ok = False
            desired = {}
            log.error("docker state unavailable", extra={"error": str(exc)})
            self.health.bump(errors=1)
            self.health.update(last_error=str(exc))

        try:
            actual = self.actual()
        except CloudflareError as exc:
            log.error("failed to list custom hostnames", extra={"error": str(exc)})
            self.health.bump(errors=1)
            self.health.update(last_error=str(exc))
            return

        plan = build_plan(desired, actual)
        self.health.update(desired_count=len(desired), actual_count=len(actual))
        log.info(
            "plan built",
            extra={
                "desired": len(desired),
                "actual": len(actual),
                "create": [e.hostname for e in plan.to_create],
                "delete": [e.hostname for e in plan.to_delete],
                "unchanged": len(plan.unchanged),
            },
        )

        decision = evaluate(
            desired_count=len(desired),
            delete_count=len(plan.to_delete),
            actual_count=len(actual),
            docker_ok=docker_ok,
            max_deletions=self.config.max_deletions_per_run,
            max_ratio=self.config.max_deletion_ratio,
        )
        if decision.blocked:
            self.health.update(latch_tripped=True, latch_reason=decision.reason)
            log.error(
                "safety latch tripped, skipping deletions",
                extra={
                    "reason": decision.reason,
                    "would_delete": [e.hostname for e in plan.to_delete],
                },
            )

        self._apply(plan, skip_deletes=decision.blocked)

        if docker_ok:
            self.health.update(last_success_ts=time.time())
        log.info("reconcile finished", extra={"duration_s": round(time.time() - started, 2)})

    def _apply(self, plan: Plan, skip_deletes: bool) -> None:
        if self.config.dry_run:
            for entry in plan.to_create:
                log.info("DRY_RUN would create", extra={"hostname": entry.hostname})
            if not skip_deletes:
                for entry in plan.to_delete:
                    log.info(
                        "DRY_RUN would delete",
                        extra={"hostname": entry.hostname, "zone": entry.zone_name},
                    )
            return

        for entry in plan.to_create:
            try:
                zone = self.zones.target_zone(entry.zone_hint)
                created = self.cf.create_custom_hostname(zone, entry.hostname)
            except CloudflareError as exc:
                # One bad hostname must not stop the rest of the run.
                log.error(
                    "create failed",
                    extra={"hostname": entry.hostname, "error": str(exc)},
                )
                self.health.bump(errors=1)
                continue
            log.info(
                "custom hostname created",
                extra={
                    "hostname": created.hostname,
                    "id": created.id,
                    "zone": created.zone_name,
                    "status": created.status,
                    "container": entry.container,
                },
            )
            self.health.bump(added=1)

        if skip_deletes:
            return

        for entry in plan.to_delete:
            try:
                self.cf.delete_custom_hostname(entry)
            except CloudflareError as exc:
                log.error(
                    "delete failed",
                    extra={"hostname": entry.hostname, "id": entry.id, "error": str(exc)},
                )
                self.health.bump(errors=1)
                continue
            log.info(
                "custom hostname deleted",
                extra={"hostname": entry.hostname, "id": entry.id, "zone": entry.zone_name},
            )
            self.health.bump(deleted=1)


def _watch_events(reconciler: Reconciler, trigger: threading.Event, stop: threading.Event) -> None:
    while not stop.is_set():
        try:
            events = reconciler.docker.client.events(decode=True, filters={"type": "container"})
            for event in events:
                if stop.is_set():
                    return
                if event.get("Action", "").split(":")[0] in WATCHED_EVENTS:
                    log.debug(
                        "docker event",
                        extra={
                            "action": event.get("Action"),
                            "name": event.get("Actor", {}).get("Attributes", {}).get("name"),
                        },
                    )
                    trigger.set()
        except (DockerException, DockerUnavailableError, OSError) as exc:
            if stop.is_set():
                return
            log.error("docker event stream lost, retrying", extra={"error": str(exc)})
            stop.wait(5.0)


def main() -> int:
    try:
        config = Config.from_env()
    except ConfigError as exc:
        setup_logging()
        logging.getLogger("reconciler").error(str(exc))
        return 2

    setup_logging(config.log_level, config.log_format)
    log.info(
        "starting cf-hostname-reconciler",
        extra={
            "dry_run": config.dry_run,
            "interval": config.reconcile_interval,
            "domains": list(config.cf_domains) or "all",
        },
    )

    health = HealthState(dry_run=config.dry_run)
    start_health_server(health, config.health_port)

    cf = CloudflareClient(config.cf_api_token, config.cf_api_base)
    try:
        cf.verify_token()
    except CloudflareError as exc:
        log.error("Cloudflare token verification failed", extra={"error": str(exc)})
        return 2

    zones = ZoneRegistry(cf, config.cf_domains, config.zone_cache_ttl)
    reconciler = Reconciler(config, cf, zones, DockerState(), health)

    stop = threading.Event()
    trigger = threading.Event()

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())

    threading.Thread(
        target=_watch_events, args=(reconciler, trigger, stop), name="events", daemon=True
    ).start()

    reconciler.run_once()

    while not stop.is_set():
        fired = trigger.wait(timeout=config.reconcile_interval)
        if stop.is_set():
            break
        if fired:
            # Debounce: a stack redeploy emits a burst of events; wait for it to settle.
            time.sleep(config.debounce_seconds)
            trigger.clear()
        reconciler.run_once()

    log.info("shutting down")
    cf.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
