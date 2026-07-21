# cf-failover

Probes origin reachability; after `FAIL_THRESHOLD` consecutive failures it flips a
wildcard DNS record from `A → your IP` to `CNAME → your Cloudflare Tunnel`,
detouring traffic through the always-on tunnel. After `RECOVER_THRESHOLD`
consecutive successes it flips back. Hysteresis avoids flapping.

```
healthy:  *.example.com  A     → PRIMARY_IP                 (direct)
failed:   *.example.com  CNAME → <uuid>.cfargotunnel.com    (tunnel)
```

## Probe modes

**`http` (default) — works on the same host.** GETs `HEALTH_URL` *through*
Cloudflare. The request crosses the inbound edge→origin hop, so if the datacenter
blocks inbound (e.g. a DDoS), Cloudflare answers `52x` and the watcher sees the
outage — even when running inside that same datacenter. Point `HEALTH_URL` at a
**permanent, direct-to-IP proxied hostname that never flips**, e.g. a record
`origin-direct.example.com` `A(proxied) → your IP`. Because that probe target is
always the IP path, it reflects inbound health independently of what
`*.example.com` is doing — no flapping.

**`tcp` — must run off-host.** Connects straight to `PING_TARGET`/`PRIMARY_IP:443`.
From the same host this hairpins and always looks up; only meaningful from an
external location.

## Scope

This protects against the **inbound path being blocked while the host is alive and
its outbound tunnel still works** (the datacenter-DDoS case). It does **not**
survive the host itself dying — the tunnel and the direct IP terminate at the same
Caddy. Real host-level redundancy needs a second origin.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CF_API_TOKEN` | — | **required**; needs `Zone:Read` + `Zone:DNS:Edit` |
| `FAILOVER_RECORD` | — | **required**; the record to flip, e.g. `*.example.com` |
| `PRIMARY_IP` | — | **required**; A-record content when healthy |
| `TUNNEL_TARGET` | — | **required**; `<uuid>.cfargotunnel.com` |
| `FAILOVER_ZONE` | *(derived)* | zone name; defaults to the registrable domain of the record |
| `PROBE_MODE` | `http` | `http` (through Cloudflare, same-host safe) or `tcp` (off-host only) |
| `HEALTH_URL` | — | http mode: a permanent direct-to-IP proxied URL, e.g. `https://origin-direct.example.com` |
| `PING_TARGET` | `PRIMARY_IP:443` | tcp mode: `host:port` to TCP-probe |
| `CHECK_INTERVAL_SECONDS` | `10` | probe interval |
| `CONNECT_TIMEOUT_SECONDS` | `5` | per-probe TCP timeout |
| `FAIL_THRESHOLD` | `3` | consecutive fails before failover |
| `RECOVER_THRESHOLD` | `3` | consecutive oks before recovery |
| `PROXIED` | `true` | keep the record orange-clouded |
| `DRY_RUN` | `false` | log the flip, change nothing |
| `HEALTH_PORT` | `8080` | `/healthz` |

If any required var is empty the service idles (no crash loop) and logs what is
missing, so it can sit in the stack until you configure it.

## Token permissions

The same `CF_API_TOKEN` the reconciler uses already covers this: `Zone:Zone:Read`
+ `Zone:DNS:Edit`. Flipping the record type (A ↔ CNAME) is a single `PUT` on the
record id. No account-level Tunnel permission is needed — this only edits DNS.

## Development

```bash
node --test
docker build -t cf-failover .
```
