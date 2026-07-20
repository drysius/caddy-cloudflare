"""End-to-end reconcile tests with fake Docker and Cloudflare clients."""

from __future__ import annotations

import pytest

from reconciler.cloudflare import CustomHostname, Zone
from reconciler.config import Config
from reconciler.docker_state import DockerUnavailableError
from reconciler.health import HealthState
from reconciler.main import Reconciler
from reconciler.zones import ZoneRegistry

ZONE_A = Zone(id="z1", name="multidesk.top")
ZONE_B = Zone(id="z2", name="outra.com")


class FakeCF:
    def __init__(self, zones=(ZONE_A,), hostnames=None):
        self._zones = list(zones)
        self._hostnames = list(hostnames or [])
        self.created: list[tuple[str, str]] = []
        self.deleted: list[str] = []

    def list_zones(self, names=()):
        if not names:
            return list(self._zones)
        # Mirror the real client: results follow CF_DOMAINS order.
        return [z for name in names for z in self._zones if z.name == name]

    def list_custom_hostnames(self, zone):
        return [h for h in self._hostnames if h.zone_id == zone.id]

    def create_custom_hostname(self, zone, hostname):
        self.created.append((zone.name, hostname))
        entry = CustomHostname(
            id=f"id-{hostname}", hostname=hostname, zone_id=zone.id, zone_name=zone.name
        )
        self._hostnames.append(entry)
        return entry

    def delete_custom_hostname(self, entry):
        self.deleted.append(entry.hostname)
        self._hostnames = [h for h in self._hostnames if h.id != entry.id]


class FakeDocker:
    def __init__(self, desired=None, fail=False):
        self._desired = desired or {}
        self._fail = fail

    def desired(self, suffixes):
        if self._fail:
            raise DockerUnavailableError("socket gone")
        return {h: e for h, e in self._desired.items() if not any(h.endswith(s) for s in suffixes)}


def make(config_overrides=None, cf=None, docker=None):
    cf = cf or FakeCF()
    config = Config(cf_api_token="t", **(config_overrides or {}))
    zones = ZoneRegistry(cf, config.cf_domains, config.zone_cache_ttl)
    return Reconciler(config, cf, zones, docker or FakeDocker(), HealthState()), cf


def entries(*hosts, zone_hint=""):
    from reconciler.docker_state import DesiredHostname

    return {h: DesiredHostname(hostname=h, zone_hint=zone_hint) for h in hosts}


def test_creates_missing_hostname():
    r, cf = make(docker=FakeDocker(entries("docs.exemplo.com")))
    r.run_once()
    assert cf.created == [("multidesk.top", "docs.exemplo.com")]


def test_deletes_orphan_hostname():
    cf = FakeCF(hostnames=[CustomHostname("id1", "velho.com", "z1", "multidesk.top")])
    r, cf = make(cf=cf, docker=FakeDocker(entries("docs.exemplo.com")))
    r.run_once()
    assert cf.deleted == ["velho.com"]


def test_zone_names_are_treated_as_internal():
    r, cf = make(docker=FakeDocker(entries("cliente.multidesk.top")))
    r.run_once()
    assert cf.created == []


def test_docker_failure_blocks_deletions():
    cf = FakeCF(hostnames=[CustomHostname("id1", "velho.com", "z1", "multidesk.top")])
    r, cf = make(cf=cf, docker=FakeDocker(fail=True))
    r.run_once()
    assert cf.deleted == []
    assert r.health.snapshot()["latch_tripped"] is True


def test_dry_run_has_no_side_effects():
    cf = FakeCF(hostnames=[CustomHostname("id1", "velho.com", "z1", "multidesk.top")])
    r, cf = make({"dry_run": True}, cf=cf, docker=FakeDocker(entries("novo.com")))
    r.run_once()
    assert cf.created == [] and cf.deleted == []


def test_multi_zone_requires_target_and_honours_hint():
    cf = FakeCF(zones=(ZONE_A, ZONE_B))
    r, cf = make(cf=cf, docker=FakeDocker(entries("docs.exemplo.com", zone_hint="outra.com")))
    r.run_once()
    assert cf.created == [("outra.com", "docs.exemplo.com")]


def test_first_cf_domain_is_the_default_target():
    cf = FakeCF(zones=(ZONE_A, ZONE_B))
    r, cf = make(
        {"cf_domains": ("outra.com", "multidesk.top")},
        cf=cf,
        docker=FakeDocker(entries("d.com")),
    )
    r.run_once()
    assert cf.created == [("outra.com", "d.com")]


def test_multi_zone_without_hint_or_domains_logs_error():
    cf = FakeCF(zones=(ZONE_A, ZONE_B))
    r, cf = make(cf=cf, docker=FakeDocker(entries("d.com")))
    r.run_once()
    assert cf.created == []
    assert r.health.snapshot()["errors"] == 1


def test_deletion_spans_all_zones():
    cf = FakeCF(
        zones=(ZONE_A, ZONE_B),
        hostnames=[
            CustomHostname("id1", "a.com", "z1", "multidesk.top"),
            CustomHostname("id2", "b.com", "z2", "outra.com"),
        ],
    )
    r, cf = make(
        {"cf_domains": ("outra.com", "multidesk.top")},
        cf=cf,
        docker=FakeDocker(entries("a.com")),
    )
    r.run_once()
    assert cf.deleted == ["b.com"]


@pytest.mark.parametrize("count", [6, 20])
def test_mass_deletion_is_latched(count):
    hosts = [CustomHostname(f"id{i}", f"h{i}.com", "z1", "multidesk.top") for i in range(count)]
    cf = FakeCF(hostnames=hosts)
    r, cf = make(cf=cf, docker=FakeDocker(entries("keep.com")))
    r.run_once()
    assert cf.deleted == []
