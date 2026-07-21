#!/usr/bin/env node
// Failover watcher: TCP-ping the origin IP directly (not through Cloudflare).
// After N consecutive failures, flip a wildcard DNS record from A->IP to
// CNAME->tunnel so traffic detours through the always-on Cloudflare Tunnel.
// After M consecutive successes, flip it back. Hysteresis avoids flapping.
//
// IMPORTANT: run this OFF the protected host. If it runs on the same box that
// goes down, it dies too and can never fail over. It also cannot reliably test
// EXTERNAL reachability from the same host (hairpin routing may make the origin
// look up when outside clients cannot reach it). See README.
import net from "node:net";
import http from "node:http";
import { decideFlip, deriveZone } from "./logic.js";

const CF_API = "https://api.cloudflare.com/client/v4";

// ---- config ---------------------------------------------------------------
const env = process.env;
const num = (k, d) => (env[k]?.trim() ? Number(env[k]) : d);
const bool = (k, d = false) => ["1", "true", "yes", "on"].includes((env[k] ?? String(d)).trim().toLowerCase());

const cfg = {
  token: (env.CF_API_TOKEN ?? "").trim(),
  record: (env.FAILOVER_RECORD ?? "").trim().toLowerCase(), // e.g. *.multidesk.top
  zone: (env.FAILOVER_ZONE ?? "").trim().toLowerCase(),
  primaryIp: (env.PRIMARY_IP ?? "").trim(),
  tunnelTarget: (env.TUNNEL_TARGET ?? "").trim().toLowerCase(), // <uuid>.cfargotunnel.com
  // "http" (default): GET HEALTH_URL through Cloudflare, so the probe crosses the
  // inbound edge->origin hop that a datacenter DDoS blocks — works even on the
  // same host. "tcp": raw connect to PING_TARGET (needs to run OFF the host).
  probeMode: (env.PROBE_MODE ?? "http").trim().toLowerCase(),
  healthUrl: (env.HEALTH_URL ?? "").trim(), // e.g. https://origin-direct.multidesk.top
  pingTarget: (env.PING_TARGET ?? "").trim(), // tcp mode: host:port; default PRIMARY_IP:443
  interval: num("CHECK_INTERVAL_SECONDS", 10) * 1000,
  connectTimeout: num("CONNECT_TIMEOUT_SECONDS", 5) * 1000,
  failThreshold: num("FAIL_THRESHOLD", 3),
  recoverThreshold: num("RECOVER_THRESHOLD", 3),
  proxied: bool("PROXIED", true),
  dryRun: bool("DRY_RUN", false),
  healthPort: num("HEALTH_PORT", 8080),
};

// Cloudflare returns these when it cannot reach the origin (the exact symptom of
// a datacenter blocking inbound). Treat them — and any network error/timeout —
// as "origin down".
const CF_ORIGIN_ERRORS = new Set([521, 522, 523, 524, 525, 526, 527]);

function log(level, msg, fields = {}) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + "\n");
}

// ---- state ----------------------------------------------------------------
const state = {
  mode: "unknown", // "primary" | "failover"
  consecutiveFails: 0,
  consecutiveOks: 0,
  lastCheckTs: null,
  lastFlipTs: null,
  lastError: null,
  flips: 0,
  zoneId: null,
  recordId: null,
};

// ---- Cloudflare API -------------------------------------------------------
async function cf(method, path, body) {
  const resp = await fetch(CF_API + path, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!data.success) throw new Error(`${method} ${path} failed: ${JSON.stringify(data.errors)}`);
  return data;
}

async function resolveIds() {
  const zres = await cf("GET", `/zones?name=${encodeURIComponent(cfg.zone)}`);
  if (!zres.result?.length) throw new Error(`zone ${cfg.zone} not found`);
  state.zoneId = zres.result[0].id;

  const rres = await cf("GET", `/zones/${state.zoneId}/dns_records?name=${encodeURIComponent(cfg.record)}`);
  const rec = rres.result?.[0];
  if (!rec) throw new Error(`record ${cfg.record} not found in ${cfg.zone}`);
  state.recordId = rec.id;
  // Current mode is inferred from the live record type.
  state.mode = rec.type === "CNAME" ? "failover" : "primary";
  log("INFO", "resolved DNS ids", { zoneId: state.zoneId, recordId: state.recordId, mode: state.mode, type: rec.type });
}

async function flip(toMode) {
  const record =
    toMode === "failover"
      ? { type: "CNAME", name: cfg.record, content: cfg.tunnelTarget, proxied: cfg.proxied, ttl: 1 }
      : { type: "A", name: cfg.record, content: cfg.primaryIp, proxied: cfg.proxied, ttl: 1 };

  if (cfg.dryRun) {
    log("WARNING", "DRY_RUN would flip", { toMode, record });
    state.mode = toMode;
    return;
  }
  await cf("PUT", `/zones/${state.zoneId}/dns_records/${state.recordId}`, record);
  state.mode = toMode;
  state.flips += 1;
  state.lastFlipTs = Date.now();
  log("ERROR", `failover: flipped ${cfg.record} to ${toMode}`, { record });
}

// ---- probes ---------------------------------------------------------------
function tcpPing(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(cfg.connectTimeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

// HTTP probe THROUGH Cloudflare: up unless the request errors/times out or
// Cloudflare reports it can't reach the origin (52x).
async function httpProbe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.connectTimeout);
  try {
    const resp = await fetch(url, { redirect: "manual", signal: ctrl.signal, cache: "no-store" });
    return !CF_ORIGIN_ERRORS.has(resp.status);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function probe() {
  if (cfg.probeMode === "tcp") {
    const [host, portStr] = (cfg.pingTarget || `${cfg.primaryIp}:443`).split(":");
    return tcpPing(host, Number(portStr || 443));
  }
  return httpProbe(cfg.healthUrl);
}

async function check() {
  const ok = await probe();
  state.lastCheckTs = Date.now();

  if (ok) {
    state.consecutiveOks += 1;
    state.consecutiveFails = 0;
  } else {
    state.consecutiveFails += 1;
    state.consecutiveOks = 0;
  }
  log("DEBUG", "probe", { ok, fails: state.consecutiveFails, oks: state.consecutiveOks, mode: state.mode });

  try {
    const target = decideFlip({
      mode: state.mode,
      consecutiveFails: state.consecutiveFails,
      consecutiveOks: state.consecutiveOks,
      failThreshold: cfg.failThreshold,
      recoverThreshold: cfg.recoverThreshold,
    });
    if (target) await flip(target);
  } catch (err) {
    state.lastError = String(err);
    log("ERROR", "flip failed", { error: String(err) });
  }
}

// ---- health server --------------------------------------------------------
function startHealth() {
  http
    .createServer((req, res) => {
      if ((req.url ?? "").replace(/\/$/, "") !== "/healthz") return res.writeHead(404).end();
      const healthy = state.lastCheckTs !== null;
      const body = JSON.stringify({ ...state, healthy });
      res.writeHead(200, { "Content-Type": "application/json" }).end(body);
    })
    .listen(cfg.healthPort, "0.0.0.0", () => log("INFO", "health server listening", { port: cfg.healthPort }));
}

// ---- main -----------------------------------------------------------------
function missingConfig() {
  const missing = [];
  if (!cfg.token) missing.push("CF_API_TOKEN");
  if (!cfg.record) missing.push("FAILOVER_RECORD");
  if (!cfg.primaryIp) missing.push("PRIMARY_IP");
  if (!cfg.tunnelTarget) missing.push("TUNNEL_TARGET");
  if (cfg.probeMode === "http" && !cfg.healthUrl) missing.push("HEALTH_URL");
  if (cfg.probeMode === "tcp" && !cfg.pingTarget && !cfg.primaryIp) missing.push("PING_TARGET");
  return missing;
}

async function main() {
  startHealth();

  const missing = missingConfig();
  if (missing.length) {
    // Sit idle instead of crash-looping, so the service can live in the stack
    // until you fill in the failover settings.
    log("WARNING", "failover disabled; set these to enable", { missing });
    setInterval(() => {}, 1 << 30);
    return;
  }
  if (!cfg.zone) cfg.zone = deriveZone(cfg.record);

  log("INFO", "starting cf-failover", {
    record: cfg.record,
    zone: cfg.zone,
    primaryIp: cfg.primaryIp,
    tunnelTarget: cfg.tunnelTarget,
    probeMode: cfg.probeMode,
    probe: cfg.probeMode === "http" ? cfg.healthUrl : cfg.pingTarget || `${cfg.primaryIp}:443`,
    failThreshold: cfg.failThreshold,
    recoverThreshold: cfg.recoverThreshold,
    dryRun: cfg.dryRun,
  });

  await resolveIds();

  const tick = () => check().catch((e) => log("ERROR", "check crashed", { error: String(e) }));
  await tick();
  setInterval(tick, cfg.interval);
}

main().catch((e) => {
  log("ERROR", "fatal", { error: String(e) });
  process.exit(1);
});
