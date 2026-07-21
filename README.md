# caddy-cloudflare

Stack central: **Caddy** (roteamento por labels) + **Cloudflare for SaaS** (custom hostnames
dos domínios de clientes, criados e removidos automaticamente).

| Componente | Imagem | O que faz |
|---|---|---|
| [`caddy/`](caddy) | `ghcr.io/<owner>/caddy-cloudflare` | Caddy compilado com `caddy-docker-proxy` + `caddy-dns/cloudflare` |
| [`cf-hostname-reconciler/`](cf-hostname-reconciler) | `ghcr.io/<owner>/cf-hostname-reconciler` | Sincroniza custom hostnames da CF com os labels `caddy_*` |

## Por que um Caddy customizado

A imagem oficial `lucaslorentz/caddy-docker-proxy` **não** traz o módulo DNS da Cloudflare.
Ele é necessário para o wildcard interno `*.multidesk.top`: HTTP-01 não emite wildcard, e o
registro está proxied atrás da Cloudflare. Então compilamos com `xcaddy`:

```dockerfile
RUN xcaddy build \
    --with github.com/lucaslorentz/caddy-docker-proxy/v2@v2.13.1 \
    --with github.com/caddy-dns/cloudflare@v0.2.4
```

Versões fixadas em `caddy/Dockerfile` via `ARG` (`CADDY_VERSION=2.11.4`).

### Caddyfile gerado no start

Nenhum domínio fica embutido na imagem. O `caddy/entrypoint.sh` renderiza
`/etc/caddy/Caddyfile` a cada boot a partir das variáveis e então executa
`caddy docker-proxy`, que faz o merge com os labels dos containers.

| Env | Efeito |
|---|---|
| `WILDCARD_DOMAINS` | lista explícita dos blocos wildcard |
| `CF_DOMAINS` | fallback: gera `*.<zona>` para cada zona |
| `ACME_EMAIL` / `ACME_CA` | bloco global |
| `DNS_RESOLVERS` | resolvers do DNS-01 (default `1.1.1.1 1.0.0.1`) |
| `CADDY_PRINT_CADDYFILE` | `true` imprime o arquivo gerado no log |
| `PREFLIGHT_DNS_CHECK` | `true` (default) testa Zone:DNS:Edit no boot criando/apagando um TXT |
| `PREFLIGHT_DNS_FATAL` | `true` aborta o container se o preflight falhar |

**Wildcard do Caddy casa apenas um label.** `*.multidesk.top` **não** cobre
`algo.chat.multidesk.top` — liste os dois em `WILDCARD_DOMAINS`.

Sem `CF_API_TOKEN`, os blocos wildcard são omitidos (DNS-01 não roda) e um aviso vai
para o log; o roteamento por labels continua funcionando.

## Fluxo de TLS

- **Domínios internos** (`*.multidesk.top`, `*.chat.multidesk.top`): cert wildcard real,
  emitido pelo próprio Caddy via **DNS-01** com `CF_API_TOKEN`.
- **Domínios de clientes** (`docs.cliente.com`): viram **custom hostname** na sua zona SaaS.
  A borda da Cloudflare apresenta o cert DV; a zona fica em **Full**, e o Caddy responde ao
  origin com `tls internal`. Nenhum cert público é emitido no origin.

## Setup (Portainer)

Não há `.env`: todos os valores ficam inline no `docker-compose.yml`, comentados.
Preencha os campos marcados **OBRIGATÓRIO** (`CF_API_TOKEN`, `ACME_EMAIL`) e confira
`CF_DOMAINS` e `CADDY_INGRESS_NETWORKS`.

1. Crie a rede uma vez: `docker network create multidesk_network`
2. Portainer → Stacks → Add stack → cole o `docker-compose.yml` no editor web
   (ou use **Repository**). O Caddyfile é gerado dentro do container a partir das
   variáveis, então não há bind mount nem dependência de arquivo local.
3. Suba primeiro com `DRY_RUN: "true"` e confira o plano em
   `docker logs cf-reconciler` antes de liberar as deleções.

### Token Cloudflare

Um único `CF_API_TOKEN`, compartilhado pelos dois serviços:

| Permissão | Para quê |
|---|---|
| `Zone:Zone:Read` | descoberta das zonas |
| `Zone:DNS:Edit` | DNS-01 do wildcard (Caddy) |
| `Zone:SSL and Certificates:Edit` | custom hostnames (reconciliador) |

### Variáveis compartilhadas

Definidas uma vez na âncora `x-cf` do compose e mergeadas nos dois serviços:
`CF_API_TOKEN`, `CF_DOMAINS`, `ACME_EMAIL`, `CADDY_INGRESS_NETWORKS`, `LOG_FORMAT`, `TZ`.
O nome da rede é uma âncora (`&net`) reaproveitada no bloco `networks`, então também
está declarado em um só lugar.

`CF_DOMAINS` é uma lista ordenada (`"a.com,b.com"`): define quais zonas são gerenciadas
e a **primeira** é a zona alvo padrão para novos custom hostnames.

## Stack de cliente (exemplo)

```yaml
services:
  app:
    image: nginx
    labels:
      caddy_0: docs.clientedele.com
      caddy_0.reverse_proxy: "{{upstreams 80}}"
      caddy_0.tls: internal
      caddy_1: cliente.multidesk.top
      caddy_1.reverse_proxy: "{{upstreams 80}}"
    networks: [multidesk_network]

networks:
  multidesk_network:
    external: true
```

`docs.clientedele.com` vira custom hostname em segundos; `cliente.multidesk.top` é coberto
pelo wildcard e **nunca** é enviado à API de custom hostnames.

## CI

`.github/workflows/build.yml`: syntax check + testes (`node --test`) do reconciliador → build
multi-arch (`linux/amd64`, `linux/arm64`) das duas imagens → push para GHCR
(`latest` na `main`, semver nas tags `v*`, SHA curto sempre).

Detalhes do reconciliador (multi-zona, trava de segurança, `DRY_RUN`, `/healthz`):
[`cf-hostname-reconciler/README.md`](cf-hostname-reconciler/README.md).
