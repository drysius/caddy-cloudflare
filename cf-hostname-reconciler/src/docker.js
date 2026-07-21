// Desired state: hostnames declared in `caddy_*` labels of running containers.
// Talks to the Docker Engine API directly over the unix socket (no dependency).
import http from "node:http";

// Only the site-block keys (`caddy`, `caddy_0`, `caddy_1`), not sub-directives
// like `caddy_1.reverse_proxy`.
const SITE_BLOCK_KEY = /^caddy(_\d+)?$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//;

// Optional per-container hint telling which Cloudflare zone owns these hostnames.
export const ZONE_LABEL = "cf_zone";

export class DockerUnavailableError extends Error {}

function normalize(raw) {
  let host = raw.trim().toLowerCase();
  if (!host) return null;
  host = host.replace(SCHEME, "");
  host = host.split("/", 1)[0];
  // Strip the port, leaving IPv6 literals alone (they are rejected below anyway).
  if (host.includes(":") && !host.startsWith("[")) host = host.split(":", 1)[0];
  host = host.replace(/\.$/, "");
  return host || null;
}

export function isManaged(host, internalSuffixes) {
  if (host.includes("{{") || host.includes("{")) return false; // unresolved template
  if (host.startsWith("*.") || host.includes("*")) return false; // wildcard
  if (!host.includes(".")) return false; // catch-all site block such as `https://`
  return !internalSuffixes.some((s) => host === s.replace(/^\./, "") || host.endsWith(s));
}

export function parseLabelValue(value, internalSuffixes) {
  const hosts = [];
  for (const chunk of value.split(",")) {
    const host = normalize(chunk);
    if (host && isManaged(host, internalSuffixes)) hosts.push(host);
  }
  return hosts;
}

export function desiredFromLabels(labels, internalSuffixes, container = "") {
  const zoneHint = (labels[ZONE_LABEL] ?? "").trim().toLowerCase();
  const out = [];
  for (const [key, value] of Object.entries(labels)) {
    if (!SITE_BLOCK_KEY.test(key)) continue;
    for (const hostname of parseLabelValue(value ?? "", internalSuffixes)) {
      out.push({ hostname, zoneHint, container });
    }
  }
  return out;
}

// Low-level GET against the Docker socket. `onLine` streams NDJSON (events);
// without it the full body is buffered and JSON-parsed.
function dockerGet(socketPath, path, onLine) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method: "GET" }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new DockerUnavailableError(`Docker API ${res.statusCode} on ${path}`));
        return;
      }
      if (onLine) {
        res.setEncoding("utf8");
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) {
              try {
                onLine(JSON.parse(line));
              } catch {
                /* ignore malformed event line */
              }
            }
          }
        });
        res.on("end", () => resolve());
      } else {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new DockerUnavailableError(`bad JSON from ${path}: ${err}`));
          }
        });
      }
      res.on("error", reject);
    });
    req.on("error", (err) => reject(new DockerUnavailableError(`cannot reach the Docker socket: ${err.message}`)));
    req.end();
  });
}

export class DockerState {
  constructor(socketPath = "/var/run/docker.sock") {
    this._socket = socketPath;
  }

  // Map hostname -> desired entry for every running container.
  // Throws DockerUnavailableError so the caller can trip the safety latch instead
  // of mistaking an unreadable socket for "no hostnames wanted".
  async desired(internalSuffixes) {
    const filters = encodeURIComponent(JSON.stringify({ status: ["running"] }));
    const containers = await dockerGet(this._socket, `/containers/json?filters=${filters}`);
    const found = new Map();
    for (const c of containers) {
      const labels = c.Labels ?? {};
      const name = (c.Names?.[0] ?? "").replace(/^\//, "");
      for (const entry of desiredFromLabels(labels, internalSuffixes, name)) {
        // First container wins; a later one cannot silently retarget the zone.
        if (!found.has(entry.hostname)) found.set(entry.hostname, entry);
      }
    }
    return found;
  }

  // Streams container events, invoking onEvent(action) for each. Resolves when the
  // stream ends (caller reconnects).
  watchEvents(onEvent) {
    const filters = encodeURIComponent(JSON.stringify({ type: ["container"] }));
    return dockerGet(this._socket, `/events?filters=${filters}`, (evt) => {
      const action = String(evt.Action ?? "").split(":")[0];
      onEvent(action, evt);
    });
  }
}
