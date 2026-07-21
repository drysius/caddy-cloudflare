// Bidirectional diff between desired labels and actual Cloudflare custom hostnames.

// desired: Map<hostname, {hostname, zoneHint, container}>
// actual:  Array<{id, hostname, zoneId, zoneName, status}>
export function buildPlan(desired, actual) {
  const actualByHost = new Map(actual.map((e) => [e.hostname, e]));

  const toCreate = [...desired.keys()]
    .sort()
    .filter((h) => !actualByHost.has(h))
    .map((h) => desired.get(h));

  const toDelete = [...actualByHost.keys()]
    .sort()
    .filter((h) => !desired.has(h))
    .map((h) => actualByHost.get(h));

  const unchanged = [...desired.keys()].filter((h) => actualByHost.has(h)).sort();

  return { toCreate, toDelete, unchanged, get empty() {
    return toCreate.length === 0 && toDelete.length === 0;
  } };
}
