ARG CADDY_VERSION=2.11.4

FROM caddy:${CADDY_VERSION}-builder-alpine AS builder

# caddy-docker-proxy: reads container labels and builds the Caddyfile.
# caddy-dns/cloudflare: DNS-01 challenge, required for the internal wildcards
# (HTTP-01 cannot issue wildcards, and the records are proxied behind Cloudflare).
ARG DOCKER_PROXY_VERSION=v2.13.1
ARG CLOUDFLARE_DNS_VERSION=v0.2.4
RUN xcaddy build \
    --with github.com/lucaslorentz/caddy-docker-proxy/v2@${DOCKER_PROXY_VERSION} \
    --with github.com/caddy-dns/cloudflare@${CLOUDFLARE_DNS_VERSION}

FROM caddy:${CADDY_VERSION}-alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# The base Caddyfile is generated at start from CF_DOMAINS / WILDCARD_DOMAINS,
# so the image carries no hardcoded domain.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENV CADDY_DOCKER_CADDYFILE_PATH=/etc/caddy/Caddyfile

# Admin API on localhost only, so the healthcheck can reach it without exposing it.
ENV CADDY_ADMIN=localhost:2019

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:2019/config/ >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["caddy", "docker-proxy"]
