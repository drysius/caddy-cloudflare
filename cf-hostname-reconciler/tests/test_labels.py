from reconciler.docker_state import desired_from_labels, parse_label_value

SUFFIXES = (".multidesk.top",)


def test_strips_scheme_and_port():
    assert parse_label_value("https://docs.exemplo.com:443", SUFFIXES) == ["docs.exemplo.com"]


def test_multiple_hosts_comma_separated():
    value = "docs.exemplo.com, app.outro.com"
    assert parse_label_value(value, SUFFIXES) == ["docs.exemplo.com", "app.outro.com"]


def test_drops_internal_suffix():
    assert parse_label_value("cliente.multidesk.top", SUFFIXES) == []
    assert parse_label_value("x.chat.multidesk.top", SUFFIXES) == []


def test_drops_wildcard_template_and_catchall():
    assert parse_label_value("*.multidesk.top", SUFFIXES) == []
    assert parse_label_value("{{DOMAIN}}", SUFFIXES) == []
    assert parse_label_value("https://", SUFFIXES) == []
    assert parse_label_value("localhost", SUFFIXES) == []


def test_only_site_block_keys_are_read():
    labels = {
        "caddy": "a.exemplo.com",
        "caddy_1": "b.exemplo.com",
        "caddy_1.reverse_proxy": "c.exemplo.com",
        "caddy_1.tls": "internal",
        "other": "d.exemplo.com",
    }
    hosts = {e.hostname for e in desired_from_labels(labels, SUFFIXES)}
    assert hosts == {"a.exemplo.com", "b.exemplo.com"}


def test_zone_hint_label():
    labels = {"caddy_0": "docs.exemplo.com", "cf_zone": "Multidesk.Top"}
    entry = desired_from_labels(labels, SUFFIXES)[0]
    assert entry.zone_hint == "multidesk.top"
