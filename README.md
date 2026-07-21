# caddy-cloudflare

A central **Caddy** reverse proxy (label-driven, via `caddy-docker-proxy`) plus a small
sidecar that keeps **Cloudflare for SaaS** custom hostnames in sync with your running
containers — so customer domains get provisioned and de-provisioned automatically.

| Component | Image | What it does |
|---|---|---|
| [`caddy/`](caddy) | `ghcr.io/drysius/caddy-cloudflare` | Caddy built with `caddy-docker-proxy` + `caddy-dns/cloudflare` |
| [`cf-hostname-reconciler/`](cf-hostname-reconciler) | `ghcr.io/drysius/cf-hostname-reconciler` | Syncs CF custom hostnames with `caddy_*` labels |

## The problem this solves

You run one Docker host serving many customers. Each customer stack declares its domains
in `caddy_*` labels; a central Caddy routes them. Two things have to happen for a customer
domain like `docs.customer.com` to work end to end:

1. **Edge**: it must exist as a **custom hostname** in your Cloudflare for SaaS zone (so
   Cloudflare terminates TLS at the edge with a valid cert). Doing this by hand for every
   onboard/offboard does not scale.
2. **Origin**: Caddy must route it. With the zone in **Full** SSL mode, Caddy answers the
   origin leg with `tls internal` — no public cert needed at the origin.

The reconciler watches Docker and reconciles (1) automatically: a label appears → the
custom hostname is created within seconds; the label disappears → it is removed. Caddy
handles (2). Your own wildcard domains (e.g. `*.example.com`) stay plain DNS and are never
turned into custom hostnames.

## Why a custom Caddy build

The official `lucaslorentz/caddy-docker-proxy` image does **not** include the Cloudflare
DNS module, which is required to issue the internal wildcard (`*.example.com`) via
**DNS-01** — HTTP-01 cannot issue wildcards, and the record sits proxied behind Cloudflare.
So we compile it with `xcaddy`:

```dockerfile
RUN xcaddy build \
    --with github.com/lucaslorentz/caddy-docker-proxy/v2@v2.13.1 \
    --with github.com/caddy-dns/cloudflare@v0.2.4
```

Versions are pinned in `caddy/Dockerfile` via `ARG` (`CADDY_VERSION=2.11.4`).

### Caddyfile generated at start

No domain is baked into the image. `caddy/entrypoint.sh` renders `/etc/caddy/Caddyfile`
from environment variables on every boot, then runs `caddy docker-proxy`, which merges it
with the container labels.

| Env | Effect |
|---|---|
| `WILDCARD_DOMAINS` | explicit list of wildcard site blocks |
| `CF_DOMAINS` | fallback: generates `*.<zone>` for each zone |
| `ACME_EMAIL` / `ACME_CA` | global block |
| `DNS_RESOLVERS` | DNS-01 resolvers (default `1.1.1.1 1.0.0.1`) |
| `CADDY_PRINT_CADDYFILE` | `true` prints the generated file to the log |
| `PREFLIGHT_DNS_CHECK` | `true` (default) tests Zone:DNS:Edit at boot by creating/deleting a TXT |
| `PREFLIGHT_DNS_FATAL` | `true` aborts the container if the preflight fails |

**A Caddy wildcard matches only one label.** `*.example.com` does **not** cover
`foo.sub.example.com` — list both in `WILDCARD_DOMAINS`.

Without `CF_API_TOKEN` the wildcard blocks are skipped (DNS-01 can't run) and a warning is
logged; label-driven routing still works.

## TLS flow

- **Internal domains** (`*.example.com`): a real wildcard cert, issued by Caddy itself via
  **DNS-01** using `CF_API_TOKEN`.
- **Customer domains** (`docs.customer.com`): become **custom hostnames** in your SaaS zone.
  Cloudflare's edge presents the DV cert; the zone is in **Full**, and Caddy answers the
  origin with `tls internal`. No public cert is issued at the origin.

## Setup (Portainer)

There is no `.env`: every value is inline in `docker-compose.yml`, and **you only edit the
`x-cf` block at the top** — nothing under `services:` needs changing. Fill the fields marked
**REQUIRED** (`CF_API_TOKEN`, `CF_DOMAINS`, `ACME_EMAIL`).

1. Create the network once: `docker network create proxy`
2. Portainer → Stacks → Add stack → paste `docker-compose.yml` into the web editor
   (or use **Repository**). The Caddyfile is generated inside the container from the
   variables, so there is no bind mount or local-file dependency.
3. Deploy first with `DRY_RUN: "true"` and check the plan in
   `docker logs cf-reconciler` before allowing deletions.

### Cloudflare token

A single `CF_API_TOKEN`, shared by both services:

| Permission | Used for |
|---|---|
| `Zone:Zone:Read` | zone discovery |
| `Zone:DNS:Edit` | wildcard DNS-01 (Caddy) |
| `Zone:SSL and Certificates:Edit` | custom hostnames (reconciler) |

On boot, Caddy runs a preflight (create+delete a TXT) and logs `PREFLIGHT OK/ERROR` so a
token missing `Zone:DNS:Edit` is obvious before ACME retries.

### Shared variables

`CF_DOMAINS` is an ordered list (`"a.com,b.com"`): it defines which zones are managed, and
the **first** entry is the default target zone for new custom hostnames. Both services read
the same `x-cf` anchor; each ignores the keys it doesn't use.

## Customer stack (example)

```yaml
services:
  app:
    image: nginx
    labels:
      caddy_0: docs.customer.com
      caddy_0.reverse_proxy: "{{upstreams 80}}"
      caddy_0.tls: internal
      caddy_1: customer.example.com
      caddy_1.reverse_proxy: "{{upstreams 80}}"
    networks: [proxy]

networks:
  proxy:
    external: true
```

`docs.customer.com` becomes a custom hostname within seconds; `customer.example.com` is
covered by the wildcard and is **never** sent to the custom-hostnames API.

## CI

`.github/workflows/build.yml`: syntax check + tests (`node --test`) for the reconciler →
multi-arch build (`linux/amd64`, `linux/arm64`) of both images → push to GHCR (`latest` on
`main`, semver on `v*` tags, short SHA always).

Reconciler details (multi-zone, safety latch, `DRY_RUN`, `/healthz`):
[`cf-hostname-reconciler/README.md`](cf-hostname-reconciler/README.md).
