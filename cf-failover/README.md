# cf-failover

TCP-pings your origin IP directly (bypassing Cloudflare). After `FAIL_THRESHOLD`
consecutive failures it flips a wildcard DNS record from `A → your IP` to
`CNAME → your Cloudflare Tunnel`, detouring traffic through the always-on tunnel.
After `RECOVER_THRESHOLD` consecutive successes it flips back. Hysteresis avoids
flapping.

```
healthy:  *.example.com  A     → PRIMARY_IP        (direct)
failed:   *.example.com  CNAME → <uuid>.cfargotunnel.com  (tunnel)
```

## Read this before relying on it

- **Run it OFF the protected host.** If it lives on the same box that goes down,
  it dies too and can never fail over. A cheap external VPS, another node, or a
  scheduled runner is the right home.
- **Same-host probing is unreliable.** Connecting to your own public IP from the
  same host can succeed via hairpin routing even when outside clients cannot
  reach it. Point `PING_TARGET` at something that reflects *external*
  reachability, or run externally.
- **It does not survive full host death.** The tunnel and the direct IP both
  terminate at the same Caddy. This protects against the IP path being
  blocked/attacked while the host is up — not against the host being gone. Real
  redundancy needs a second origin (see Cloudflare Load Balancer).

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CF_API_TOKEN` | — | **required**; needs `Zone:Read` + `Zone:DNS:Edit` |
| `FAILOVER_RECORD` | — | **required**; the record to flip, e.g. `*.example.com` |
| `PRIMARY_IP` | — | **required**; A-record content when healthy |
| `TUNNEL_TARGET` | — | **required**; `<uuid>.cfargotunnel.com` |
| `FAILOVER_ZONE` | *(derived)* | zone name; defaults to the registrable domain of the record |
| `PING_TARGET` | `PRIMARY_IP:443` | `host:port` to TCP-probe |
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
