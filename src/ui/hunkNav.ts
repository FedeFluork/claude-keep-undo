import { Hunk, hunkLineRange } from "../diff";

/**
 * Which hunk the caret is on. Inside a hunk that one wins; between hunks the
 * nearest range (by line distance) does, so the extra CodeLenses have a home
 * even when the cursor sits in unchanged text.
 */
export function currentHunkIndex(hunks: readonly Hunk[], line: number): number {
  if (hunks.length === 0) {
    return 0;
  }
  for (let i = 0; i < hunks.length; i++) {
    const { start, end } = hunkLineRange(hunks[i]);
    if (line >= start && line <= end) {
      return i;
    }
  }
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < hunks.length; i++) {
    const { start, end } = hunkLineRange(hunks[i]);
    const dist = line < start ? start - line : line - end;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/**
 * Next / previous hunk in file order, wrapping so a click at either end keeps
 * walking rather than going silent.
 */
export function neighborHunkIndex(
  hunks: readonly Hunk[],
  index: number,
  direction: 1 | -1
): number {
  const n = hunks.length;
  if (n === 0) {
    return 0;
  }
  const order = hunks
    .map((_, i) => i)
    .sort((a, b) => hunks[a].currentStart - hunks[b].currentStart);
  const pos = order.indexOf(index);
  if (pos === -1) {
    return index;
  }
  return order[(pos + direction + n) % n];
}
