// Core reconcile logic: diff desired labels against actual CF hostnames, apply.
import { CloudflareError } from "./cloudflare.js";
import { buildPlan } from "./diff.js";
import { DockerUnavailableError } from "./docker.js";
import { log } from "./logging.js";
import { evaluateLatch } from "./safety.js";

export class Reconciler {
  constructor(config, cf, zones, docker, health) {
    this.config = config;
    this.cf = cf;
    this.zones = zones;
    this.docker = docker;
    this.health = health;
    this._running = false;
    this._pending = false;
  }

  // Configured suffixes plus every managed zone name: hostnames inside your own
  // zones are plain DNS records, never custom hostnames.
  async internalSuffixes() {
    const zoneSuffixes = (await this.zones.zoneNames()).map((n) => `.${n}`);
    return [...this.config.internalSuffixes, ...zoneSuffixes];
  }

  async actual() {
    const entries = [];
    for (const zone of await this.zones.zones()) {
      entries.push(...(await this.cf.listCustomHostnames(zone)));
    }
    return entries;
  }

  // Serialize runs; coalesce overlapping triggers into one follow-up pass.
  async runOnce() {
    if (this._running) {
      this._pending = true;
      return;
    }
    this._running = true;
    try {
      await this._runOnce();
    } finally {
      this._running = false;
      if (this._pending) {
        this._pending = false;
        await this.runOnce();
      }
    }
  }

  async _runOnce() {
    const started = Date.now();
    this.health.update({ lastRunTs: started, latchTripped: false, latchReason: "" });

    let suffixes;
    try {
      suffixes = await this.internalSuffixes();
      this.health.update({ zones: await this.zones.zoneNames() });
    } catch (err) {
      log.error("zone discovery failed", { error: String(err) });
      this.health.bump({ errors: 1 });
      this.health.update({ lastError: String(err) });
      return;
    }

    let dockerOk = true;
    let desired = new Map();
    try {
      desired = await this.docker.desired(suffixes);
    } catch (err) {
      if (!(err instanceof DockerUnavailableError)) throw err;
      dockerOk = false;
      log.error("docker state unavailable", { error: String(err) });
      this.health.bump({ errors: 1 });
      this.health.update({ lastError: String(err) });
    }

    let actual;
    try {
      actual = await this.actual();
    } catch (err) {
      log.error("failed to list custom hostnames", { error: String(err) });
      this.health.bump({ errors: 1 });
      this.health.update({ lastError: String(err) });
      return;
    }

    const plan = buildPlan(desired, actual);
    this.health.update({ desiredCount: desired.size, actualCount: actual.length });
    log.info("plan built", {
      desired: desired.size,
      actual: actual.length,
      create: plan.toCreate.map((e) => e.hostname),
      delete: plan.toDelete.map((e) => e.hostname),
      unchanged: plan.unchanged.length,
    });

    const decision = evaluateLatch({
      desiredCount: desired.size,
      deleteCount: plan.toDelete.length,
      actualCount: actual.length,
      dockerOk,
      maxDeletions: this.config.maxDeletionsPerRun,
      maxRatio: this.config.maxDeletionRatio,
    });
    if (decision.blocked) {
      this.health.update({ latchTripped: true, latchReason: decision.reason });
      log.error("safety latch tripped, skipping deletions", {
        reason: decision.reason,
        would_delete: plan.toDelete.map((e) => e.hostname),
      });
    }

    await this._apply(plan, decision.blocked);

    if (dockerOk) this.health.update({ lastSuccessTs: Date.now() });
    log.info("reconcile finished", { duration_s: (Date.now() - started) / 1000 });
  }

  async _apply(plan, skipDeletes) {
    if (this.config.dryRun) {
      for (const e of plan.toCreate) log.info("DRY_RUN would create", { hostname: e.hostname });
      if (!skipDeletes) {
        for (const e of plan.toDelete) log.info("DRY_RUN would delete", { hostname: e.hostname, zone: e.zoneName });
      }
      return;
    }

    for (const entry of plan.toCreate) {
      try {
        const zone = await this.zones.targetZone(entry.zoneHint);
        const created = await this.cf.createCustomHostname(zone, entry.hostname);
        log.info("custom hostname created", {
          hostname: created.hostname,
          id: created.id,
          zone: created.zoneName,
          status: created.status,
          container: entry.container,
        });
        this.health.bump({ added: 1 });
      } catch (err) {
        if (!(err instanceof CloudflareError)) throw err;
        // One bad hostname must not stop the rest of the run.
        log.error("create failed", { hostname: entry.hostname, error: String(err) });
        this.health.bump({ errors: 1 });
      }
    }

    if (skipDeletes) return;

    for (const entry of plan.toDelete) {
      try {
        await this.cf.deleteCustomHostname(entry);
        log.info("custom hostname deleted", { hostname: entry.hostname, id: entry.id, zone: entry.zoneName });
        this.health.bump({ deleted: 1 });
      } catch (err) {
        if (!(err instanceof CloudflareError)) throw err;
        log.error("delete failed", { hostname: entry.hostname, id: entry.id, error: String(err) });
        this.health.bump({ errors: 1 });
      }
    }
  }
}
