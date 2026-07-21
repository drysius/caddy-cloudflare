# cf-hostname-reconciler

Keeps **Cloudflare for SaaS** *custom hostnames* in sync with the domains declared in the
`caddy_*` labels of your Docker containers (the
[`lucaslorentz/caddy-docker-proxy`](https://github.com/lucaslorentz/caddy-docker-proxy)
convention).

A container comes up with `caddy_0: docs.customer.com` → the custom hostname is created
within seconds. The container goes away → the hostname is removed on the next reconcile.

## Multi-zone (no `CF_ZONE_ID`)

No zone IDs to declare. The service calls `GET /zones` with the token and discovers every
visible zone; use `CF_DOMAINS` (an ordered list, e.g. `"a.com,b.com"`) to restrict it to a
subset.

- **Actual state** = the union of custom hostnames across **all** managed zones. Each entry
  carries its `zone_id`, so a `DELETE` always targets the right zone.
- **Creation** needs a target zone, resolved in this order:
  1. the container's `cf_zone` label (e.g. `cf_zone: other.com`);
  2. the **first** `CF_DOMAINS` entry;
  3. the only managed zone, if there is just one.

  With multiple zones, an empty `CF_DOMAINS` and no label, that one hostname's creation
  fails with a logged error — the rest continue.

> In Cloudflare for SaaS the custom hostname lives in **your** SaaS zone, not in the
> customer's zone (`customer.com` isn't even on your account). "Multi-domain" here means
> **you** own several zones, each able to hold custom hostnames.

## Label filtering

Only keys matching `^caddy(_\d+)?$` are read (the site block; sub-directives like
`caddy_1.reverse_proxy` are ignored). For each value: multiple comma-separated hosts,
`http(s)://` / path / port stripped. Dropped values:

| Value | Reason |
|---|---|
| `customer.example.com` | ends in a managed zone name (plain DNS, not a custom hostname) |
| `*.example.com` | wildcard |
| `{{DOMAIN}}` | unresolved template |
| `https://` | catch-all, no `.` |

Managed zone names become internal suffixes **automatically**; `INTERNAL_SUFFIXES` is only
for extra suffixes.

## Safety latch

The **delete** phase is aborted (logged at `ERROR`, nothing executed) if:

- the desired set is empty;
- reading the Docker socket failed;
- deletions would exceed `MAX_DELETIONS_PER_RUN` (default 5) **or**
  `MAX_DELETION_RATIO` (default 0.3) of all hostnames on Cloudflare.

Additions are never blocked. `DRY_RUN=true` prints the full plan with no side effects.

## Cloudflare token

My Profile → API Tokens → Create Token → Custom token:

- `Zone` → `Zone` → **Read** (zone discovery)
- `Zone` → `SSL and Certificates` → **Edit** (custom hostnames)
- Zone Resources: `Include` → `All zones` (or specific zones)

At boot the service does a `GET /zones` liveness check and exits with code 2 if it fails.
(It does not use `/user/tokens/verify`: some valid scoped tokens are rejected by that
endpoint.)

## Full SSL mode

The zone runs in **Full** — **not Full (Strict)**. Caddy uses `tls internal` for customer
hostnames: Cloudflare's edge presents the valid cert (DV issued via `ssl.method=http`) and
the CF→origin leg is encrypted with the internal cert. Full (Strict) would reject the
self-signed internal cert with a cert-invalid error; use a Cloudflare Origin Certificate if
you need Strict. The reconciler does **not** manage origin certificates — it only
creates/removes custom hostnames with `ssl: { method: "http", type: "dv" }`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CF_API_TOKEN` | — | **required** |
| `CF_DOMAINS` | *(all)* | managed zones, comma-separated; the 1st is the default target |
| `INTERNAL_SUFFIXES` | *(empty)* | extra suffixes to ignore |
| `RECONCILE_INTERVAL` | `3600` | periodic safety net (s) |
| `DEBOUNCE_SECONDS` | `5` | wait after a burst of events |
| `ZONE_CACHE_TTL` | `900` | zone-list cache (s) |
| `MAX_DELETIONS_PER_RUN` | `5` | absolute latch |
| `MAX_DELETION_RATIO` | `0.3` | proportional latch |
| `DRY_RUN` | `false` | plan without executing |
| `LOG_LEVEL` | `INFO` | |
| `LOG_FORMAT` | `text` | `json` for structured logs |
| `HEALTH_PORT` | `8080` | |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker socket path |

## Docker socket permissions

The image runs as a non-root user, so it needs the host's `docker` group to read
`/var/run/docker.sock`. Without it you get `EACCES ... /var/run/docker.sock` and the
container stays `unhealthy`. Find the GID and add it to the service:

```bash
getent group docker | cut -d: -f3   # e.g. 999
```

```yaml
  cf-reconciler:
    group_add:
      - "999"   # the GID from the command above
```

Alternative: `user: "0:0"` to run as root (simpler, less isolated).

## Triggers

`docker events` (`start`, `die`, `destroy`, `update`) with a ~5s debounce, plus a reconcile
every `RECONCILE_INTERVAL` and one at boot. If the event stream drops, it reconnects on its
own.

## Health

```
GET http://localhost:8080/healthz
```

```json
{
  "lastSuccessTs": 1721480000000,
  "added": 3, "deleted": 1, "errors": 0,
  "latchTripped": false, "latchReason": "",
  "zones": ["example.com"],
  "desiredCount": 12, "actualCount": 12,
  "dryRun": false, "healthy": true
}
```

## Usage

The full-stack compose (Caddy + reconciler) lives at the repository root — see the root
[README](../README.md). Example customer stack:

```yaml
services:
  app:
    image: nginx
    labels:
      caddy_0: docs.customer.com
      caddy_0.reverse_proxy: "{{upstreams 80}}"
      caddy_0.tls: internal
      cf_zone: example.com   # optional; only needed with multiple zones
    networks: [proxy]
```

## Development

Node 20+ (ESM, **no runtime dependencies** — native `fetch`, the Docker socket via
`node:http`, healthz via `node:http`). Tests use Node's built-in runner.

```bash
node --test
docker build -t cf-hostname-reconciler .
```

CI: syntax check + tests → multi-arch build (`linux/amd64`, `linux/arm64`) → push to
`ghcr.io/<owner>/cf-hostname-reconciler` (`latest` on main, semver on `v*` tags, short SHA
always).
