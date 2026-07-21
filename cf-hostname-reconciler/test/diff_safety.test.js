import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlan } from "../src/diff.js";
import { evaluateLatch } from "../src/safety.js";

const ch = (hostname, zoneId = "z1", zoneName = "example.com") => ({
  id: `id-${hostname}`,
  hostname,
  zoneId,
  zoneName,
});
const desired = (...hosts) => new Map(hosts.map((h) => [h, { hostname: h, zoneHint: "" }]));

test("plan creates and deletes", () => {
  const plan = buildPlan(desired("a.com", "b.com"), [ch("b.com"), ch("c.com")]);
  assert.deepEqual(plan.toCreate.map((e) => e.hostname), ["a.com"]);
  assert.deepEqual(plan.toDelete.map((e) => e.hostname), ["c.com"]);
  assert.deepEqual(plan.unchanged, ["b.com"]);
});

test("plan empty when in sync", () => {
  assert.equal(buildPlan(desired("a.com"), [ch("a.com")]).empty, true);
});

test("delete keeps zone of origin", () => {
  const plan = buildPlan(new Map(), [ch("c.com", "z9", "outro.com")]);
  assert.equal(plan.toDelete[0].zoneId, "z9");
});

const latch = (over = {}) =>
  evaluateLatch({
    desiredCount: 10,
    deleteCount: 1,
    actualCount: 10,
    dockerOk: true,
    maxDeletions: 5,
    maxRatio: 0.3,
    ...over,
  });

test("latch allows small deletion", () => assert.equal(latch().blocked, false));
test("latch blocks when docker unavailable", () => assert.equal(latch({ dockerOk: false }).blocked, true));
test("latch blocks on empty desired set", () => assert.equal(latch({ desiredCount: 0 }).blocked, true));
test("latch blocks over absolute cap", () =>
  assert.equal(latch({ deleteCount: 6, actualCount: 100 }).blocked, true));
test("latch blocks over ratio", () =>
  assert.equal(latch({ deleteCount: 4, actualCount: 10, maxDeletions: 50 }).blocked, true));
test("latch noop when nothing to delete", () =>
  assert.equal(latch({ deleteCount: 0, desiredCount: 3 }).blocked, false));
