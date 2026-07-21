// Pure helpers, kept side-effect free so they can be unit-tested.

// Derive the zone from a record name: strip a leading "*." and take the
// registrable domain (last two labels). Override with FAILOVER_ZONE for
// multi-level public suffixes (e.g. example.co.uk).
export function deriveZone(record) {
  const base = record.replace(/^\*\./, "");
  return base.split(".").slice(-2).join(".");
}

// Decide whether to flip, given the current mode and consecutive counters.
// Returns "failover", "primary", or null (no change). Hysteresis: only flip
// after the relevant threshold of consecutive results, and never re-flip to the
// mode we are already in.
export function decideFlip({ mode, consecutiveFails, consecutiveOks, failThreshold, recoverThreshold }) {
  if (mode !== "failover" && consecutiveFails >= failThreshold) return "failover";
  if (mode === "failover" && consecutiveOks >= recoverThreshold) return "primary";
  return null;
}
