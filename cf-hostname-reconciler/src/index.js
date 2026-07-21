#!/usr/bin/env node
// Entrypoint: event-driven + interval reconciliation loop.
import { CloudflareClient, CloudflareError } from "./cloudflare.js";
import { ConfigError, loadConfig } from "./config.js";
import { DockerState } from "./docker.js";
import { HealthState, startHealthServer } from "./health.js";
import { log, setupLogging } from "./logging.js";
import { Reconciler } from "./reconciler.js";
import { ZoneRegistry } from "./zones.js";

const WATCHED_EVENTS = new Set(["start", "die", "destroy", "update"]);

async function watchEvents(reconciler, docker, debounceMs, stopped) {
  let timer = null;
  const trigger = () => {
    // Debounce: a stack redeploy emits a burst of events; wait for it to settle.
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => reconciler.runOnce().catch((e) => log.error("reconcile crashed", { error: String(e) })), debounceMs);
  };

  while (!stopped.value) {
    try {
      await docker.watchEvents((action, evt) => {
        if (WATCHED_EVENTS.has(action)) {
          log.debug("docker event", { action, name: evt.Actor?.Attributes?.name });
          trigger();
        }
      });
    } catch (err) {
      if (stopped.value) return;
      log.error("docker event stream lost, retrying", { error: String(err) });
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    setupLogging();
    log.error(err.message);
    return 2;
  }

  setupLogging(config.logLevel, config.logFormat);
  log.info("starting cf-hostname-reconciler", {
    dry_run: config.dryRun,
    interval: config.reconcileInterval,
    domains: config.cfDomains.length ? config.cfDomains : "all",
  });

  const health = new HealthState(config.dryRun);
  const healthServer = startHealthServer(health, config.healthPort);

  const cf = new CloudflareClient(config.cfApiToken, config.cfApiBase);
  const zones = new ZoneRegistry(cf, config.cfDomains, config.zoneCacheTtl);

  // Liveness check: list zones. (We deliberately avoid /user/tokens/verify, which
  // rejects some valid scoped/account tokens.)
  try {
    await zones.zones(true);
  } catch (err) {
    if (!(err instanceof CloudflareError)) throw err;
    log.error("Cloudflare zone discovery failed at boot; check CF_API_TOKEN", { error: String(err) });
    return 2;
  }

  const docker = new DockerState(config.dockerSocket);
  const reconciler = new Reconciler(config, cf, zones, docker, health);

  const stopped = { value: false };
  const shutdown = () => {
    stopped.value = true;
    log.info("shutting down");
    healthServer.close();
    clearInterval(interval);
    setTimeout(() => process.exit(0), 100);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  watchEvents(reconciler, docker, config.debounceSeconds * 1000, stopped);
  const interval = setInterval(
    () => reconciler.runOnce().catch((e) => log.error("reconcile crashed", { error: String(e) })),
    config.reconcileInterval * 1000,
  );

  await reconciler.runOnce();
  return null; // keep the process alive on the event loop
}

const code = await main();
if (code !== null) process.exit(code);
