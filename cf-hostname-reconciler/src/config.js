// Configuration loaded from environment variables.

export class ConfigError extends Error {}

function bool(name, def = false) {
  const raw = (process.env[name] ?? String(def)).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

function num(name, def) {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return def;
  const value = Number(raw);
  if (Number.isNaN(value)) throw new ConfigError(`${name} must be a number, got ${JSON.stringify(raw)}`);
  return value;
}

function csv(name) {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  const token = (env.CF_API_TOKEN ?? "").trim();
  if (!token) {
    throw new ConfigError(
      "Missing required environment variable CF_API_TOKEN. The token needs " +
        "Zone:Read (zone discovery) and SSL and Certificates:Edit on every managed zone.",
    );
  }

  // Extra suffixes never turned into custom hostnames; ensure a leading dot.
  const internalSuffixes = csv("INTERNAL_SUFFIXES").map((s) => (s.startsWith(".") ? s : `.${s}`));

  return {
    cfApiToken: token,
    // Zones to manage, in priority order. Empty => every zone the token can see.
    // The first entry is the default target for newly created custom hostnames.
    cfDomains: csv("CF_DOMAINS"),
    internalSuffixes,
    zoneCacheTtl: num("ZONE_CACHE_TTL", 900),
    reconcileInterval: num("RECONCILE_INTERVAL", 3600),
    debounceSeconds: num("DEBOUNCE_SECONDS", 5),
    maxDeletionsPerRun: num("MAX_DELETIONS_PER_RUN", 5),
    maxDeletionRatio: num("MAX_DELETION_RATIO", 0.3),
    dryRun: bool("DRY_RUN", false),
    logLevel: (env.LOG_LEVEL ?? "INFO").trim().toUpperCase(),
    logFormat: (env.LOG_FORMAT ?? "text").trim().toLowerCase(),
    healthPort: num("HEALTH_PORT", 8080),
    dockerSocket: (env.DOCKER_SOCKET ?? "/var/run/docker.sock").trim(),
    cfApiBase: (env.CF_API_BASE ?? "https://api.cloudflare.com/client/v4").trim().replace(/\/$/, ""),
  };
}
