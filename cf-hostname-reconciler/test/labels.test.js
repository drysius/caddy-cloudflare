import assert from "node:assert/strict";
import { test } from "node:test";
import { desiredFromLabels, parseLabelValue } from "../src/docker.js";

const SUFFIXES = [".example.com"];

test("strips scheme, path and port", () => {
  assert.deepEqual(parseLabelValue("https://docs.exemplo.com:443/x", SUFFIXES), ["docs.exemplo.com"]);
});

test("multiple hosts comma separated", () => {
  assert.deepEqual(parseLabelValue("docs.exemplo.com, app.outro.com", SUFFIXES), [
    "docs.exemplo.com",
    "app.outro.com",
  ]);
});

test("drops internal suffix", () => {
  assert.deepEqual(parseLabelValue("cliente.example.com", SUFFIXES), []);
  assert.deepEqual(parseLabelValue("x.chat.example.com", SUFFIXES), []);
});

test("drops wildcard, template and catch-all", () => {
  assert.deepEqual(parseLabelValue("*.example.com", SUFFIXES), []);
  assert.deepEqual(parseLabelValue("{{DOMAIN}}", SUFFIXES), []);
  assert.deepEqual(parseLabelValue("https://", SUFFIXES), []);
  assert.deepEqual(parseLabelValue("localhost", SUFFIXES), []);
});

test("only site-block keys are read", () => {
  const labels = {
    caddy: "a.exemplo.com",
    caddy_1: "b.exemplo.com",
    "caddy_1.reverse_proxy": "c.exemplo.com",
    "caddy_1.tls": "internal",
    other: "d.exemplo.com",
  };
  const hosts = new Set(desiredFromLabels(labels, SUFFIXES).map((e) => e.hostname));
  assert.deepEqual(hosts, new Set(["a.exemplo.com", "b.exemplo.com"]));
});

test("zone hint label", () => {
  const entry = desiredFromLabels({ caddy_0: "docs.exemplo.com", cf_zone: "Example.Com" }, SUFFIXES)[0];
  assert.equal(entry.zoneHint, "example.com");
});
