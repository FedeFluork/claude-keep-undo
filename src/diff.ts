/**
 * Minimal, dependency-free line diff engine.
 *
 * Produces line-level "hunks" between a baseline text (the file content before
 * Claude touched it) and the current text (Claude's modified content). Each hunk
 * describes a contiguous region that differs, with the exact line ranges on both
 * sides so we can:
 *   - render Keep/Undo affordances at the right place in the editor, and
 *   - apply a Keep (accept into baseline) or Undo (revert the file) per hunk.
 *
 * The engine is Myers' O((N+M)·D) algorithm over interned lines, preceded by
 * common prefix/suffix peeling. For the shape of edit this extension sees — a
 * few changed lines in an otherwise untouched file — D is tiny, so the work is
 * effectively linear even on large files. That matters because recompute runs on
 * every debounced keystroke in a tracked file.
 */

export interface Hunk {
  /** Position in the current recompute's hunk list; used as a command argument. */
  index: number;
  /**
   * Content-derived identity, stable across recomputes as long as the hunk
   * itself is. UI surfaces pass it back with the command so an action fired
   * against a stale rendering can be refused instead of applied to whatever now
   * occupies that index.
   */
  fingerprint: string;
  /** 0-based start line of the removed region in the baseline. */
  baselineStart: number;
  /** Lines present in the baseline but not (as-is) in the current content. */
  baselineLines: string[];
  /** 0-based start line of the added region in the current content. */
  currentStart: number;
  /** Lines present in the current content but not in the baseline. */
  currentLines: string[];
  /**
   * Set when this hunk came from the fallback path: the two versions were too
   * different to split, so the whole changed region is reported as one
   * replacement. Surfaced in the UI so "why is it all one hunk?" has an answer.
   */
  degraded?: boolean;
  /**
   * Set when the two sides hold the same lines and differ only in their line
   * terminators. The diff itself is deliberately EOL-insensitive, so such a
   * change has no per-line rendering — the UI says so in words instead.
   */
  eolOnly?: boolean;
}

/**
 * Beyond this edit distance the two texts have essentially nothing in common;
 * reporting one replacement is both cheaper and more useful than an
 * interleaving of thousands of single-line edits. Reached only after prefix and
 * suffix peeling, so in practice only by genuinely unrelated content.
 */
const MAX_EDIT_DISTANCE = 1200;

/** Detect the dominant line ending of a text so round-trips stay stable. */
export function detectEol(text: string): "\n" | "\r\n" {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? "\r\n" : "\n";
}

/** Split into lines, dropping the line terminators (EOL handled separately). */
export function splitLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  return text.replace(/\r\n/g, "\n").split("\n");
}

/**
 * A line plus the exact terminator that followed it (`""` for the final line).
 *
 * Splicing at this granularity is what lets Keep/Undo touch only the lines in
 * the hunk. Rebuilding the text from `splitLines` + a single detected EOL used
 * to rewrite *every* terminator in the file, so one three-line Undo in a
 * mixed-EOL or CRLF file produced a diff touching every line in `git status`.
 */
export interface LineUnit {
  content: string;
  eol: string;
}

export function toUnits(text: string): LineUnit[] {
  if (text === "") {
    return [];
  }
  const units: LineUnit[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10 /* \n */) {
      continue;
    }
    const crlf = i > start && text.charCodeAt(i - 1) === 13; /* \r */
    units.push({
      content: text.slice(start, crlf ? i - 1 : i),
      eol: crlf ? "\r\n" : "\n",
    });
    start = i + 1;
  }
  units.push({ content: text.slice(start), eol: "" });
  return units;
}

export function fromUnits(units: LineUnit[]): string {
  let out = "";
  for (const unit of units) {
    out += unit.content + unit.eol;
  }
  return out;
}

/**
 * Replace `count` units at `start` with `insert`, keeping every untouched
 * terminator byte-identical and repairing only the two boundaries: a unit that
 * used to be last now needs a terminator, and the unit that is last now must
 * not have one.
 */
function spliceUnits(
  target: LineUnit[],
  start: number,
  count: number,
  insert: LineUnit[],
  fallbackEol: string
): LineUnit[] {
  const next: LineUnit[] = [
    ...target.slice(0, start),
    ...insert.map((u) => ({ ...u })),
    ...target.slice(start + count),
  ];
  // Which terminator a newly-interior unit gets. The block being inserted is the
  // best source: its terminators came verbatim from the other side of the diff,
  // so they are the ones the file itself uses. Then the target's own. The
  // caller's guess is a last resort because `detectEol` cannot do better than
  // "\n" for a text that contains no terminator at all — which is exactly the
  // case that arises here, and which used to silently convert the boundary line
  // of a CRLF file with no final newline to LF.
  const boundary =
    insert.find((u) => u.eol !== "")?.eol ??
    target.find((u) => u.eol !== "")?.eol ??
    fallbackEol;
  for (let i = 0; i < next.length - 1; i++) {
    if (next[i].eol === "") {
      next[i].eol = boundary;
    }
  }
  if (next.length > 0) {
    next[next.length - 1].eol = "";
  }
  return next;
}

// --- hunk identity ---------------------------------------------------------

function fnv1a(text: string, seed = 0x811c9dc5): string {
  let hash = seed;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export type HunkShape = Omit<Hunk, "index" | "fingerprint">;

/**
 * Digest of a hunk's lines: one pass over every character, no allocation.
 *
 * This used to sample the first and last hundred lines plus the length, on the
 * reasoning that the fingerprint was only the first of two guards and that
 * `keepHunkInBaseline`/`undoHunkInCurrent` would catch anything it missed by
 * verifying the target offsets on both sides. That justification does not hold:
 * those checks compare a slice of a text against lines derived from that same
 * text, and for a pure deletion the target-side check has nothing to compare at
 * all. So the sample was the only guard, and it was blind to the entire middle of
 * any hunk longer than 200 lines — which is every whole-file rewrite. A later
 * edit inside one produced a byte-identical fingerprint, so a comment thread went
 * on rendering the previous revision while Keep acted on the current one.
 *
 * The sample was there for cost, and giving it up is not free: fingerprinting a
 * 40 000-line hunk takes ~24 ms against ~0 for the sample. That is the right trade
 * at the only size where it is measurable. A hunk that large is a whole-file
 * rewrite, `computeHunks` spends ~62 ms producing it, and the alternative to
 * spending the extra 40% is a Keep that silently applies content the user was
 * never shown. For every ordinary hunk the two are indistinguishable.
 *
 * Two seeds, as in {@link textDigest}, so a collision needs both.
 */
function digestLines(lines: string[]): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b1;
  const mix = (code: number): void => {
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x01000193) >>> 0;
  };
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      mix(line.charCodeAt(i));
    }
    mix(10 /* the separator, so ["ab"] and ["a","b"] differ */);
  }
  const hex = (h: number): string => h.toString(16).padStart(8, "0");
  return `${lines.length}:${hex(a)}${hex(b)}`;
}

/**
 * Digest of a whole text, used to skip a recompute when nothing has changed.
 *
 * One allocation-free pass over the string, versus `splitLines` (which allocates
 * one string per line) followed by a Myers search. The length is mixed in, so a
 * collision would need both the same size and the same hash.
 */
export function textDigest(text: string): string {
  return `${text.length}:${fnv1a(text)}${fnv1a(text, 0x9e3779b1)}`;
}

/** Content + position digest of a hunk. Not cryptographic; a staleness guard. */
export function hunkFingerprint(shape: HunkShape): string {
  const payload =
    `${shape.baselineStart}:${shape.currentStart}:` +
    `${shape.baselineLines.length}:${shape.currentLines.length} ` +
    `${digestLines(shape.baselineLines)} ${digestLines(shape.currentLines)}`;
  return `${fnv1a(payload)}${fnv1a(payload, 0x9e3779b1)}`;
}

function makeHunk(index: number, shape: HunkShape): Hunk {
  return { index, fingerprint: hunkFingerprint(shape), ...shape };
}

// --- diff ------------------------------------------------------------------

type Op = { type: "equal" | "del" | "ins"; line: string };
type Step = { type: "equal" | "del" | "ins"; index: number };

/** Map lines to integers so the inner loops compare numbers, not strings. */
function internLines(a: string[], b: string[]): [Int32Array, Int32Array] {
  const ids = new Map<string, number>();
  const encode = (lines: string[]): Int32Array => {
    const out = new Int32Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      let id = ids.get(lines[i]);
      if (id === undefined) {
        id = ids.size;
        ids.set(lines[i], id);
      }
      out[i] = id;
    }
    return out;
  };
  return [encode(a), encode(b)];
}

/**
 * Myers' greedy shortest-edit-script search. Returns undefined when the edit
 * distance exceeds `maxD`, which bounds both runtime and the O(D²) trace.
 */
function myers(a: Int32Array, b: Int32Array, maxD: number): Step[] | undefined {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, maxD);
  const offset = limit;
  const v = new Int32Array(2 * limit + 1);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset]; // move down: an insertion from b
      } else {
        x = v[k - 1 + offset] + 1; // move right: a deletion from a
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, offset, n, m);
      }
    }
  }
  return undefined;
}

function backtrack(
  trace: Int32Array[],
  offset: number,
  n: number,
  m: number
): Step[] {
  const steps: Step[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK =
      k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])
        ? k + 1
        : k - 1;
    const prevX = v[prevK + offset];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      steps.push({ type: "equal", index: x - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        steps.push({ type: "ins", index: y - 1 });
      } else {
        steps.push({ type: "del", index: x - 1 });
      }
      x = prevX;
      y = prevY;
    }
  }
  steps.reverse();
  return steps;
}

function diffOps(a: string[], b: string[]): { ops: Op[]; degraded: boolean } {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) {
    return { ops: [], degraded: false };
  }
  if (n === 0) {
    return {
      ops: b.map((line) => ({ type: "ins" as const, line })),
      degraded: false,
    };
  }
  if (m === 0) {
    return {
      ops: a.map((line) => ({ type: "del" as const, line })),
      degraded: false,
    };
  }

  // Peel the identical head and tail. A typical Claude edit touches a handful of
  // lines, so this is what keeps the edit distance — and therefore the cost —
  // small regardless of file size.
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < n - prefix &&
    suffix < m - prefix &&
    a[n - 1 - suffix] === b[m - 1 - suffix]
  ) {
    suffix++;
  }

  const aMid = a.slice(prefix, n - suffix);
  const bMid = b.slice(prefix, m - suffix);

  let middle: Op[];
  let degraded = false;
  if (aMid.length === 0) {
    middle = bMid.map((line) => ({ type: "ins" as const, line }));
  } else if (bMid.length === 0) {
    middle = aMid.map((line) => ({ type: "del" as const, line }));
  } else {
    const [ia, ib] = internLines(aMid, bMid);
    const script = myers(ia, ib, MAX_EDIT_DISTANCE);
    if (script) {
      middle = script.map((step) =>
        step.type === "ins"
          ? { type: "ins" as const, line: bMid[step.index] }
          : step.type === "del"
            ? { type: "del" as const, line: aMid[step.index] }
            : { type: "equal" as const, line: aMid[step.index] }
      );
    } else {
      degraded = true;
      middle = [
        ...aMid.map((line) => ({ type: "del" as const, line })),
        ...bMid.map((line) => ({ type: "ins" as const, line })),
      ];
    }
  }

  const ops: Op[] = [];
  for (let i = 0; i < prefix; i++) {
    ops.push({ type: "equal", line: a[i] });
  }
  ops.push(...middle);
  for (let i = n - suffix; i < n; i++) {
    ops.push({ type: "equal", line: a[i] });
  }
  return { ops, degraded };
}

/** Compute the hunks between baseline and current text. */
export function computeHunks(baseline: string, current: string): Hunk[] {
  const a = splitLines(baseline);
  const b = splitLines(current);
  const { ops, degraded } = diffOps(a, b);

  const hunks: Hunk[] = [];
  let baseLine = 0;
  let curLine = 0;
  let k = 0;
  while (k < ops.length) {
    if (ops[k].type === "equal") {
      baseLine++;
      curLine++;
      k++;
      continue;
    }
    // Collect a contiguous run of non-equal ops into one hunk.
    const shape: HunkShape = {
      baselineStart: baseLine,
      baselineLines: [],
      currentStart: curLine,
      currentLines: [],
    };
    while (k < ops.length && ops[k].type !== "equal") {
      if (ops[k].type === "del") {
        shape.baselineLines.push(ops[k].line);
        baseLine++;
      } else {
        shape.currentLines.push(ops[k].line);
        curLine++;
      }
      k++;
    }
    if (degraded) {
      shape.degraded = true;
    }
    hunks.push(makeHunk(hunks.length, shape));
  }
  return hunks;
}

// --- applying --------------------------------------------------------------

/**
 * Whether `units` holds exactly `expected` at `start`.
 *
 * Note what this cannot do: an empty `expected` matches at *any* in-range
 * position, because there is nothing to compare. Every hunk describing a pure
 * deletion has `currentLines: []`, so the current-side check in
 * {@link undoHunkInCurrent} is vacuous for all of them. That is why the store
 * gates every apply on the digest of the content the hunks were computed
 * against — this function cannot be the guard on its own.
 */
function sliceMatches(
  units: LineUnit[],
  start: number,
  expected: string[]
): boolean {
  if (start < 0 || start + expected.length > units.length) {
    return false;
  }
  for (let i = 0; i < expected.length; i++) {
    if (units[start + i].content !== expected[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Apply a Keep: fold the current lines of one hunk into the baseline so that
 * region stops being a difference.
 *
 * Both texts are needed because the replacement lines are taken from `current`
 * *with their own terminators*, so the result keeps every line ending exactly as
 * it was on either side.
 *
 * Returns undefined when the baseline no longer contains exactly the lines the
 * hunk claims to replace — the hunk was computed against a different revision
 * and splicing at those offsets would corrupt unrelated content. This is a
 * backstop, not the primary guard: see {@link sliceMatches} for what it cannot
 * detect.
 */
export function keepHunkInBaseline(
  baseline: string,
  current: string,
  hunk: Hunk
): string | undefined {
  const target = toUnits(baseline);
  const source = toUnits(current);
  if (!sliceMatches(target, hunk.baselineStart, hunk.baselineLines)) {
    return undefined;
  }
  if (!sliceMatches(source, hunk.currentStart, hunk.currentLines)) {
    return undefined;
  }
  const insert = source.slice(
    hunk.currentStart,
    hunk.currentStart + hunk.currentLines.length
  );
  return fromUnits(
    spliceUnits(
      target,
      hunk.baselineStart,
      hunk.baselineLines.length,
      insert,
      detectEol(baseline || current || "\n")
    )
  );
}

/**
 * Apply an Undo: revert one hunk in the current content back to the baseline
 * lines. Returns the new current text, or undefined when either side no longer
 * matches what the hunk was computed from — with the large exception described in
 * {@link sliceMatches}, which is why the caller must check the content digest
 * first.
 */
export function undoHunkInCurrent(
  current: string,
  baseline: string,
  hunk: Hunk
): string | undefined {
  const target = toUnits(current);
  const source = toUnits(baseline);
  if (!sliceMatches(target, hunk.currentStart, hunk.currentLines)) {
    return undefined;
  }
  if (!sliceMatches(source, hunk.baselineStart, hunk.baselineLines)) {
    return undefined;
  }
  const insert = source.slice(
    hunk.baselineStart,
    hunk.baselineStart + hunk.baselineLines.length
  );
  return fromUnits(
    spliceUnits(
      target,
      hunk.currentStart,
      hunk.currentLines.length,
      insert,
      detectEol(current || baseline || "\n")
    )
  );
}

// --- VS Code quick diff interop --------------------------------------------

/**
 * A change as reported by VS Code's Quick Diff peek widget to commands
 * contributed to the `scm/change/title` menu, which are invoked with
 * `(uri, changes, index)`.
 *
 * Line numbers are **1-based and inclusive**. An `end` of `0` means "empty range
 * on this side": `originalEndLineNumber === 0` is a pure insertion (nothing was
 * removed, and `originalStartLineNumber` is the line *after which* the insert
 * happened), and `modifiedEndLineNumber === 0` is a pure deletion.
 */
export interface LineChange {
  readonly originalStartLineNumber: number;
  readonly originalEndLineNumber: number;
  readonly modifiedStartLineNumber: number;
  readonly modifiedEndLineNumber: number;
}

/**
 * Translate a VS Code {@link LineChange} into one of our {@link Hunk}s, resolved
 * against the exact baseline/current texts the change was computed from.
 *
 * This lets Keep/Undo act on *the change the user is looking at* in the quick
 * diff widget rather than on a hunk index that may have shifted since the UI was
 * rendered. Returns `undefined` when the coordinates do not fit the given texts.
 *
 * That is a bounds test and nothing more. It catches a file that shrank; it does
 * not catch one that *shifted*, because the returned lines are sliced out of the
 * very texts they are then verified against — the check in
 * {@link undoHunkInCurrent} compares a slice with itself and cannot fail. The
 * staleness the widget really suffers from is that VS Code computed the change
 * list from its editor model at some earlier moment, so the caller has to
 * cross-check the result against the hunks the store holds.
 */
export function lineChangeToHunk(
  change: LineChange,
  baseline: string,
  current: string,
  index = 0
): Hunk | undefined {
  const baselineLines = splitLines(baseline);
  const currentLines = splitLines(current);

  // VS Code's text model always has at least one line, so for an *empty* side it
  // reports `[1, 1]` — one line — where `splitLines("")` yields none. Taking that
  // at face value fails the range check below and makes every action on such a
  // change look stale. It bit hardest on files Claude created, whose baseline is
  // empty by construction: Keep and Undo from the Quick Diff widget could never
  // be applied to them at all.
  //
  // Only the *empty* side may be special-cased, though. Returning the whole file
  // regardless of the reported coordinates meant a click on one change in a file
  // Claude had filled from empty accepted — or wiped — all of it.
  if (baseline === "") {
    const emptyModified = change.modifiedEndLineNumber === 0;
    const curStart = emptyModified
      ? change.modifiedStartLineNumber
      : change.modifiedStartLineNumber - 1;
    const curEnd = emptyModified ? curStart : change.modifiedEndLineNumber;
    if (curStart < 0 || curEnd < curStart || curEnd > currentLines.length) {
      return undefined;
    }
    return makeHunk(index, {
      baselineStart: 0,
      baselineLines: [],
      currentStart: curStart,
      currentLines: currentLines.slice(curStart, curEnd),
    });
  }

  // The mirror case, which had no handling at all: a file Claude emptied. Every
  // coordinate shape VS Code can report for it fails the range check below or
  // yields a hunk whose baseline lines stop short of the phantom trailing line,
  // so the widget's Undo was either refused forever or dropped the restored
  // file's final newline.
  if (current === "") {
    return makeHunk(index, {
      baselineStart: 0,
      baselineLines: splitLines(baseline),
      currentStart: 0,
      currentLines: [],
    });
  }

  const emptyOriginal = change.originalEndLineNumber === 0;
  const emptyModified = change.modifiedEndLineNumber === 0;

  // 0-based, [start, end) half-open.
  const baseStart = emptyOriginal
    ? change.originalStartLineNumber
    : change.originalStartLineNumber - 1;
  const baseEnd = emptyOriginal ? baseStart : change.originalEndLineNumber;
  const curStart = emptyModified
    ? change.modifiedStartLineNumber
    : change.modifiedStartLineNumber - 1;
  const curEnd = emptyModified ? curStart : change.modifiedEndLineNumber;

  if (
    baseStart < 0 ||
    baseEnd < baseStart ||
    baseEnd > baselineLines.length ||
    curStart < 0 ||
    curEnd < curStart ||
    curEnd > currentLines.length
  ) {
    return undefined;
  }

  return makeHunk(index, {
    baselineStart: baseStart,
    baselineLines: baselineLines.slice(baseStart, baseEnd),
    currentStart: curStart,
    currentLines: currentLines.slice(curStart, curEnd),
  });
}

/**
 * Whether `inner` describes a region entirely inside `outer`, on both sides.
 *
 * Used to validate a hunk derived from VS Code's quick-diff coordinates against
 * the hunks the store computed. An exact fingerprint match would be too strict:
 * VS Code's change list can legitimately be finer-grained than ours — a file
 * Claude created from empty is one hunk here and several bars there — and
 * refusing those is how the widget's Keep/Undo stopped working on created files
 * before. Containment accepts a narrower slice of a real difference while still
 * rejecting coordinates that point into a region the store considers unchanged,
 * which is what a stale widget produces.
 */
export function hunkCovers(outer: Hunk, inner: Hunk): boolean {
  const within = (
    outerStart: number,
    outerLen: number,
    innerStart: number,
    innerLen: number
  ): boolean =>
    innerStart >= outerStart && innerStart + innerLen <= outerStart + outerLen;
  return (
    within(
      outer.baselineStart,
      outer.baselineLines.length,
      inner.baselineStart,
      inner.baselineLines.length
    ) &&
    within(
      outer.currentStart,
      outer.currentLines.length,
      inner.currentStart,
      inner.currentLines.length
    )
  );
}

/**
 * The one hunk that stands for "same lines, different line terminators".
 *
 * {@link computeHunks} normalizes CRLF before diffing, which is the right
 * behaviour for display — a terminator change has no sensible per-line rendering.
 * But it also makes an EOL-only rewrite indistinguishable from no change at all,
 * and "no change" is what tells the store the file has been fully reviewed and
 * its baseline can be deleted. That is the ordinary outcome of Claude's Write
 * tool touching a CRLF file, and it took the original bytes with it.
 *
 * Representing the difference as one real whole-file hunk keeps the file
 * reviewable through every existing surface, and both actions land byte-exactly:
 * the units carry their own terminators, so folding either side into the other
 * reproduces it verbatim.
 */
export function eolOnlyHunk(baseline: string, current: string): Hunk {
  return makeHunk(0, {
    baselineStart: 0,
    baselineLines: splitLines(baseline),
    currentStart: 0,
    currentLines: splitLines(current),
    eolOnly: true,
  });
}

/**
 * The 0-based line range a hunk occupies in the *current* content. A pure
 * deletion has no lines of its own, so it collapses to the single line where the
 * removed text used to be.
 */
export function hunkLineRange(hunk: Hunk): { start: number; end: number } {
  const start = hunk.currentStart;
  const end =
    hunk.currentLines.length > 0 ? start + hunk.currentLines.length - 1 : start;
  return { start, end };
}
