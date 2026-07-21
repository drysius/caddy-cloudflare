# cf-hostname-reconciler

Mantém os *custom hostnames* do **Cloudflare for SaaS** sincronizados com os domínios
declarados nos labels `caddy_*` dos containers Docker (padrão
[`lucaslorentz/caddy-docker-proxy`](https://github.com/lucaslorentz/caddy-docker-proxy)).

Container sobe com `caddy_0: docs.cliente.com` → o custom hostname é criado em segundos.
Container some → o hostname é removido na próxima reconciliação.

## Multi-zona (sem `CF_ZONE_ID`)

Não é preciso declarar zone IDs. O serviço chama `GET /zones` com o token e descobre
todas as zonas visíveis; use `CF_DOMAINS` (lista ordenada, ex.: `"a.com,b.com"`) para
restringir a um subconjunto.

- **Estado real** = união dos custom hostnames de **todas** as zonas gerenciadas.
  Cada entrada carrega seu `zone_id`, então o `DELETE` sempre vai na zona correta.
- **Criação** precisa de uma zona alvo, resolvida nesta ordem:
  1. label `cf_zone` no container (ex.: `cf_zone: outracoisa.com`);
  2. a **primeira** entrada de `CF_DOMAINS`;
  3. a única zona gerenciada, se houver só uma.

  Com várias zonas, `CF_DOMAINS` vazio e sem label, a criação daquele hostname falha
  com erro logado — as demais continuam.

> No Cloudflare for SaaS o custom hostname vive na **sua** zona SaaS, não na zona do
> cliente (`clientedele.com` sequer está na sua conta). "Multi-domínio" aqui significa
> que **você** tem várias zonas próprias, cada uma podendo receber custom hostnames.

## Filtragem de labels

Só chaves que casem com `^caddy(_\d+)?$` são lidas (o site block; sub-diretivas como
`caddy_1.reverse_proxy` são ignoradas). Para cada valor: múltiplos hosts por vírgula,
remoção de `http(s)://`, path e porta. São descartados:

| Valor | Motivo |
|---|---|
| `cliente.multidesk.top` | termina em nome de zona gerenciada (DNS normal, não custom hostname) |
| `*.multidesk.top` | wildcard |
| `{{DOMAIN}}` | template não resolvido |
| `https://` | catch-all, sem `.` |

Nomes das zonas gerenciadas viram sufixos internos **automaticamente**;
`INTERNAL_SUFFIXES` só é necessário para sufixos extras.

## Trava de segurança

A fase de **deleção** é abortada (log `ERROR`, nada executado) se:

- o conjunto desejado estiver vazio;
- a leitura do Docker socket falhar;
- as deleções excederem `MAX_DELETIONS_PER_RUN` (default 5) **ou**
  `MAX_DELETION_RATIO` (default 0.3) do total de hostnames na Cloudflare.

Adições nunca são bloqueadas. `DRY_RUN=true` imprime o plano inteiro sem efeitos colaterais.

## Token Cloudflare

My Profile → API Tokens → Create Token → Custom token:

- `Zone` → `Zone` → **Read** (descoberta das zonas)
- `Zone` → `SSL and Certificates` → **Edit** (custom hostnames)
- Zone Resources: `Include` → `All zones` (ou as zonas específicas)

No boot o serviço faz um `GET /zones` como teste de liveness e sai com código 2 se
falhar. (Não usa `/user/tokens/verify`: alguns tokens válidos com escopo restrito
são rejeitados por esse endpoint.)

## SSL em modo Full

A zona fica em **Full**. O Caddy usa `tls internal` para os hostnames de clientes: a
borda da Cloudflare apresenta o certificado válido (DV emitido via `ssl.method=http`) e
a conexão CF→origin é criptografada com o cert interno. O reconciliador **não** gerencia
certificados no origin — apenas cria/remove os custom hostnames com
`ssl: { method: "http", type: "dv" }`.

## Configuração

| Variável | Default | Descrição |
|---|---|---|
| `CF_API_TOKEN` | — | **obrigatória** |
| `CF_DOMAINS` | *(todas)* | zonas gerenciadas, por vírgula; a 1ª é o alvo padrão |
| `INTERNAL_SUFFIXES` | *(vazio)* | sufixos extras a ignorar |
| `RECONCILE_INTERVAL` | `3600` | rede de segurança periódica (s) |
| `DEBOUNCE_SECONDS` | `5` | espera após rajada de eventos |
| `ZONE_CACHE_TTL` | `900` | cache da lista de zonas (s) |
| `MAX_DELETIONS_PER_RUN` | `5` | trava absoluta |
| `MAX_DELETION_RATIO` | `0.3` | trava proporcional |
| `DRY_RUN` | `false` | plano sem execução |
| `LOG_LEVEL` | `INFO` | |
| `LOG_FORMAT` | `text` | `json` para logs estruturados |
| `HEALTH_PORT` | `8080` | |

## Gatilhos

`docker events` (`start`, `die`, `destroy`, `update`) com debounce de ~5s, mais uma
reconciliação a cada `RECONCILE_INTERVAL` e uma no boot. Se o stream de eventos cair,
ele reconecta sozinho.

## Health

```
GET http://localhost:8080/healthz
```

```json
{
  "lastSuccessTs": 1721480000000,
  "added": 3, "deleted": 1, "errors": 0,
  "latchTripped": false, "latchReason": "",
  "zones": ["multidesk.top"],
  "desiredCount": 12, "actualCount": 12,
  "dryRun": false, "healthy": true
}
```

## Uso

O compose da stack completa (Caddy + reconciliador) fica na raiz do repositório:

```bash
cd ..
cp .env.example .env   # preencha CF_API_TOKEN
docker compose up -d
```

Exemplo de stack de cliente:

```yaml
services:
  app:
    image: nginx
    labels:
      caddy_0: docs.clientedele.com
      caddy_0.reverse_proxy: "{{upstreams 80}}"
      caddy_0.tls: internal
      cf_zone: multidesk.top   # opcional; só necessário com múltiplas zonas
    networks: [multidesk_network]
```

## Desenvolvimento

Node 20+ (ESM, **sem dependências de runtime** — `fetch` nativo, socket do Docker via
`node:http`, healthz via `node:http`). Testes com o runner embutido do Node.

```bash
node --test
docker build -t cf-hostname-reconciler .
```

CI: lint + testes → build multi-arch (`linux/amd64`, `linux/arm64`) → push para
`ghcr.io/<owner>/cf-hostname-reconciler` (`latest` na main, semver nas tags `v*`,
SHA curto sempre).
