import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { DockerUnavailableError } from "../src/docker.js";
import { HealthState } from "../src/health.js";
import { Reconciler } from "../src/reconciler.js";
import { setupLogging } from "../src/logging.js";
import { ZoneRegistry } from "../src/zones.js";

setupLogging("ERROR", "text"); // keep test output quiet

const ZONE_A = { id: "z1", name: "multidesk.top" };
const ZONE_B = { id: "z2", name: "outra.com" };

class FakeCF {
  constructor(zones = [ZONE_A], hostnames = []) {
    this._zones = zones;
    this._hostnames = [...hostnames];
    this.created = [];
    this.deleted = [];
  }
  async listZones(names = []) {
    if (!names.length) return this._zones;
    return names.flatMap((n) => this._zones.filter((z) => z.name === n));
  }
  async listCustomHostnames(zone) {
    return this._hostnames.filter((h) => h.zoneId === zone.id);
  }
  async createCustomHostname(zone, hostname) {
    this.created.push([zone.name, hostname]);
    const e = { id: `id-${hostname}`, hostname, zoneId: zone.id, zoneName: zone.name };
    this._hostnames.push(e);
    return e;
  }
  async deleteCustomHostname(entry) {
    this.deleted.push(entry.hostname);
    this._hostnames = this._hostnames.filter((h) => h.id !== entry.id);
  }
}

class FakeDocker {
  constructor(desired = new Map(), fail = false) {
    this._desired = desired;
    this._fail = fail;
  }
  async desired(suffixes) {
    if (this._fail) throw new DockerUnavailableError("socket gone");
    const out = new Map();
    for (const [h, e] of this._desired) {
      if (!suffixes.some((s) => h.endsWith(s))) out.set(h, e);
    }
    return out;
  }
}

const ch = (id, hostname, zoneId, zoneName) => ({ id, hostname, zoneId, zoneName });
const entries = (...hosts) =>
  new Map(hosts.map((h) => [h, { hostname: h, zoneHint: "", container: "" }]));
const entryHint = (host, zoneHint) => new Map([[host, { hostname: host, zoneHint, container: "" }]]);

function make({ overrides = {}, cf = new FakeCF(), docker = new FakeDocker() } = {}) {
  const config = { ...loadConfig({ CF_API_TOKEN: "t" }), ...overrides };
  const zones = new ZoneRegistry(cf, config.cfDomains, config.zoneCacheTtl);
  const health = new HealthState();
  return { r: new Reconciler(config, cf, zones, docker, health), cf, health };
}

test("creates missing hostname", async () => {
  const { r, cf } = make({ docker: new FakeDocker(entries("docs.exemplo.com")) });
  await r.runOnce();
  assert.deepEqual(cf.created, [["multidesk.top", "docs.exemplo.com"]]);
});

test("deletes orphan hostname", async () => {
  const cf = new FakeCF([ZONE_A], [ch("id1", "velho.com", "z1", "multidesk.top")]);
  const { r } = make({ cf, docker: new FakeDocker(entries("docs.exemplo.com")), overrides: { maxDeletionRatio: 1 } });
  await r.runOnce();
  assert.deepEqual(cf.deleted, ["velho.com"]);
});

test("zone names are treated as internal", async () => {
  const { r, cf } = make({ docker: new FakeDocker(entries("cliente.multidesk.top")) });
  await r.runOnce();
  assert.deepEqual(cf.created, []);
});

test("docker failure blocks deletions", async () => {
  const cf = new FakeCF([ZONE_A], [ch("id1", "velho.com", "z1", "multidesk.top")]);
  const { r, health } = make({ cf, docker: new FakeDocker(new Map(), true) });
  await r.runOnce();
  assert.deepEqual(cf.deleted, []);
  assert.equal(health.snapshot().latchTripped, true);
});

test("dry run has no side effects", async () => {
  const cf = new FakeCF([ZONE_A], [ch("id1", "velho.com", "z1", "multidesk.top")]);
  const { r } = make({ cf, docker: new FakeDocker(entries("novo.com")), overrides: { dryRun: true } });
  await r.runOnce();
  assert.deepEqual(cf.created, []);
  assert.deepEqual(cf.deleted, []);
});

test("multi-zone honours cf_zone hint", async () => {
  const cf = new FakeCF([ZONE_A, ZONE_B]);
  const { r } = make({ cf, docker: new FakeDocker(entryHint("docs.exemplo.com", "outra.com")) });
  await r.runOnce();
  assert.deepEqual(cf.created, [["outra.com", "docs.exemplo.com"]]);
});

test("first CF_DOMAINS entry is default target", async () => {
  const cf = new FakeCF([ZONE_A, ZONE_B]);
  const { r } = make({ cf, docker: new FakeDocker(entries("d.com")), overrides: { cfDomains: ["outra.com", "multidesk.top"] } });
  await r.runOnce();
  assert.deepEqual(cf.created, [["outra.com", "d.com"]]);
});

test("multi-zone without hint or domains records an error", async () => {
  const cf = new FakeCF([ZONE_A, ZONE_B]);
  const { r, health } = make({ cf, docker: new FakeDocker(entries("d.com")) });
  await r.runOnce();
  assert.deepEqual(cf.created, []);
  assert.equal(health.snapshot().errors, 1);
});

test("deletion spans all zones", async () => {
  const cf = new FakeCF(
    [ZONE_A, ZONE_B],
    [ch("id1", "a.com", "z1", "multidesk.top"), ch("id2", "b.com", "z2", "outra.com")],
  );
  const { r } = make({
    cf,
    docker: new FakeDocker(entries("a.com")),
    overrides: { cfDomains: ["outra.com", "multidesk.top"], maxDeletionRatio: 1 },
  });
  await r.runOnce();
  assert.deepEqual(cf.deleted, ["b.com"]);
});

for (const count of [6, 20]) {
  test(`mass deletion is latched (${count})`, async () => {
    const hostnames = Array.from({ length: count }, (_, i) => ch(`id${i}`, `h${i}.com`, "z1", "multidesk.top"));
    const cf = new FakeCF([ZONE_A], hostnames);
    const { r } = make({ cf, docker: new FakeDocker(entries("keep.com")) });
    await r.runOnce();
    assert.deepEqual(cf.deleted, []);
  });
}
