from reconciler.cloudflare import CustomHostname
from reconciler.diff import build_plan
from reconciler.docker_state import DesiredHostname
from reconciler.safety import evaluate


def ch(host, zone_id="z1", zone="multidesk.top"):
    return CustomHostname(id=f"id-{host}", hostname=host, zone_id=zone_id, zone_name=zone)


def desired(*hosts):
    return {h: DesiredHostname(hostname=h) for h in hosts}


def test_plan_creates_and_deletes():
    plan = build_plan(desired("a.com", "b.com"), [ch("b.com"), ch("c.com")])
    assert [e.hostname for e in plan.to_create] == ["a.com"]
    assert [e.hostname for e in plan.to_delete] == ["c.com"]
    assert plan.unchanged == ["b.com"]


def test_plan_empty_when_in_sync():
    assert build_plan(desired("a.com"), [ch("a.com")]).empty


def test_delete_keeps_zone_of_origin():
    plan = build_plan({}, [ch("c.com", zone_id="z9", zone="outro.com")])
    assert plan.to_delete[0].zone_id == "z9"


def latch(**kw):
    base = dict(
        desired_count=10,
        delete_count=1,
        actual_count=10,
        docker_ok=True,
        max_deletions=5,
        max_ratio=0.3,
    )
    return evaluate(**{**base, **kw})


def test_latch_allows_small_deletion():
    assert not latch().blocked


def test_latch_blocks_when_docker_unavailable():
    assert latch(docker_ok=False).blocked


def test_latch_blocks_on_empty_desired_set():
    assert latch(desired_count=0).blocked


def test_latch_blocks_over_absolute_cap():
    assert latch(delete_count=6, actual_count=100).blocked


def test_latch_blocks_over_ratio():
    assert latch(delete_count=4, actual_count=10, max_deletions=50).blocked


def test_latch_noop_when_nothing_to_delete():
    assert not latch(delete_count=0, desired_count=3).blocked
