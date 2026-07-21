// Minimal /healthz endpoint backed by the built-in http server.
import http from "node:http";
import { log } from "./logging.js";

export class HealthState {
  constructor(dryRun = false) {
    this.lastSuccessTs = null;
    this.lastRunTs = null;
    this.lastError = null;
    this.added = 0;
    this.deleted = 0;
    this.errors = 0;
    this.latchTripped = false;
    this.latchReason = "";
    this.zones = [];
    this.desiredCount = 0;
    this.actualCount = 0;
    this.dryRun = dryRun;
  }

  update(fields) {
    Object.assign(this, fields);
  }

  bump(fields) {
    for (const [k, v] of Object.entries(fields)) this[k] += v;
  }

  snapshot() {
    return { ...this, healthy: this.lastSuccessTs !== null };
  }
}

export function startHealthServer(state, port) {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "").replace(/\/$/, "");
    if (req.method !== "GET" || (path !== "/healthz" && path !== "")) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.stringify(state.snapshot());
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  });
  server.listen(port, "0.0.0.0", () => log.info("health server listening", { port }));
  return server;
}
