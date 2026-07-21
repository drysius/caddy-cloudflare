// Safety latch guarding the deletion phase. Additions are never blocked.

export function evaluateLatch({
  desiredCount,
  deleteCount,
  actualCount,
  dockerOk,
  maxDeletions,
  maxRatio,
}) {
  if (!dockerOk) return { blocked: true, reason: "docker state unavailable; refusing to delete anything" };
  if (desiredCount === 0) return { blocked: true, reason: "desired hostname set is empty; refusing to delete anything" };
  if (deleteCount === 0) return { blocked: false, reason: "" };
  if (deleteCount > maxDeletions) {
    return { blocked: true, reason: `${deleteCount} deletions exceed MAX_DELETIONS_PER_RUN=${maxDeletions}` };
  }
  if (actualCount && deleteCount / actualCount > maxRatio) {
    return { blocked: true, reason: `${deleteCount}/${actualCount} deletions exceed MAX_DELETION_RATIO=${maxRatio}` };
  }
  return { blocked: false, reason: "" };
}
