import assert from "node:assert/strict";
import { test } from "node:test";
import { decideFlip, deriveZone } from "../src/logic.js";

test("deriveZone strips wildcard and keeps registrable domain", () => {
  assert.equal(deriveZone("*.example.com"), "example.com");
  assert.equal(deriveZone("*.sub.example.com"), "example.com");
  assert.equal(deriveZone("example.com"), "example.com");
});

const d = (over) => decideFlip({ mode: "primary", consecutiveFails: 0, consecutiveOks: 0, failThreshold: 3, recoverThreshold: 3, ...over });

test("flips to failover only after fail threshold", () => {
  assert.equal(d({ consecutiveFails: 2 }), null);
  assert.equal(d({ consecutiveFails: 3 }), "failover");
});

test("does not re-flip to the mode it is already in", () => {
  assert.equal(d({ mode: "failover", consecutiveFails: 9 }), null);
  assert.equal(d({ mode: "primary", consecutiveOks: 9 }), null);
});

test("recovers to primary only after recover threshold", () => {
  assert.equal(d({ mode: "failover", consecutiveOks: 2 }), null);
  assert.equal(d({ mode: "failover", consecutiveOks: 3 }), "primary");
});
