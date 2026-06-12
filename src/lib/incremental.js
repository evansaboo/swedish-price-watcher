// ═══════════════════════════════════════════════════════════════
// Incremental (delta) scanning — shared policy
//
// Sources with stable listing order can stop paginating once
// `stopPages` consecutive pages contain only already-known items.
// The engine pre-populates sourceState.knownExternalIds each scan.
//
// Safety valve: every `incrementalFullScanEvery`-th scan (default 5)
// runs a full pass anyway. This catches items that enter the listing
// late in the sort order and gives the engine a complete snapshot to
// prune stale items against (partial scans never prune).
// ═══════════════════════════════════════════════════════════════

/**
 * Decide whether this scan runs incrementally.
 * Returns { active, knownIds, stopPages }; mutates the scan counter on sourceState.
 */
export function resolveIncrementalMode(source, sourceState, { defaultStopPages = null } = {}) {
  const knownIds = sourceState.knownExternalIds instanceof Set
    ? sourceState.knownExternalIds
    : new Set();

  const stopPages = Number.isFinite(source.incrementalStopPages) && source.incrementalStopPages > 0
    ? source.incrementalStopPages
    : defaultStopPages;

  if (!stopPages || knownIds.size === 0) {
    sourceState.incrementalScanCount = 0;
    return { active: false, knownIds, stopPages: null };
  }

  const fullEvery = Number.isFinite(source.incrementalFullScanEvery) && source.incrementalFullScanEvery > 0
    ? source.incrementalFullScanEvery
    : 5;
  const count = Number.isFinite(sourceState.incrementalScanCount) ? sourceState.incrementalScanCount : 0;

  if (count + 1 >= fullEvery) {
    sourceState.incrementalScanCount = 0;
    return { active: false, knownIds, stopPages: null };
  }

  sourceState.incrementalScanCount = count + 1;
  return { active: true, knownIds, stopPages };
}
