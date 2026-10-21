import { perf } from '../perf/stats.js';

/** The drawn-frame count at which each attribute last asked for a full upload. */
const fullAt = new WeakMap();

/**
 * Attribute uploads that may be whole or partial. three uploads only the update ranges when there are any,
 * so a range added after a full update was asked for (a hover right after a recolor, in the same frame)
 * would cut that full update down to the range. A full update is remembered until the next drawn frame
 * (when it is uploaded); ranges asked for meanwhile ride along with it.
 */
export function uploadAll(attr) {
  if (!attr) return;
  attr.clearUpdateRanges();
  attr.needsUpdate = true;
  fullAt.set(attr, perf.renders);
}

/** Uploads `count` values from `start` (array indices), or all of them if a full upload is waiting. */
export function uploadRange(attr, start, count) {
  if (!attr) return;
  if (fullAt.get(attr) !== perf.renders) attr.addUpdateRange(start, count);
  attr.needsUpdate = true;
}
