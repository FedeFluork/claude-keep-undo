import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeHunks,
  detectEol,
  eolOnlyHunk,
  fromUnits,
  hunkCovers,
  hunkFingerprint,
  keepHunkInBaseline,
  lineChangeToHunk,
  splitLines,
  textDigest,
  toUnits,
  undoHunkInCurrent,
} from "../../diff";

const lines = (...values: string[]) => values.join("\n");

describe("textDigest", () => {
  it("is stable for the same text and differs for different text", () => {
    assert.equal(textDigest("alpha\nbeta\n"), textDigest("alpha\nbeta\n"));
    assert.notEqual(textDigest("alpha\nbeta\n"), textDigest("alpha\nbet\n"));
  });

  it("separates texts of the same length", () => {
    // The short-circuit in recompute leans on this: same length, one character
    // apart, must not look unchanged.
    assert.notEqual(textDigest("abc"), textDigest("abd"));
  });

  it("distinguishes the empty text from a single newline", () => {
    assert.notEqual(textDigest(""), textDigest("\n"));
  });
});

describe("lineChangeToHunk against an empty original", () => {
  // VS Code's text model always has at least one line, so for an empty original
  // its dirty-diff engine reports [1,1] — never the [0,0] "pure insertion"
  // shape. `splitLines("")` yields no lines, so taking [1,1] literally failed
  // the range check and made every Keep/Undo on a file Claude created look
  // stale from the Quick Diff widget.
  const asVsCodeReportsIt = {
    originalStartLineNumber: 1,
    originalEndLineNumber: 1,
    modifiedStartLineNumber: 1,
    modifiedEndLineNumber: 4,
  };

  it("resolves the shape VS Code actually emits", () => {
    const hunk = lineChangeToHunk(asVsCodeReportsIt, "", "a\nb\nc\n");
    assert.ok(hunk, "an empty original must still resolve");
    assert.deepEqual(hunk.baselineLines, []);
    assert.deepEqual(hunk.currentLines, ["a", "b", "c", ""]);
  });

  it("undoes to nothing, which is what makes the file removable", () => {
    const hunk = lineChangeToHunk(asVsCodeReportsIt, "", "a\nb\nc\n");
    assert.equal(undoHunkInCurrent("a\nb\nc\n", "", hunk!), "");
  });

  it("still resolves the pure-insertion shape", () => {
    const hunk = lineChangeToHunk(
      {
        originalStartLineNumber: 0,
        originalEndLineNumber: 0,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 3,
      },
      "",
      "a\nb\nc"
    );
    assert.ok(hunk);
    assert.deepEqual(hunk.baselineLines, []);
  });

  it("leaves a non-empty original alone", () => {
    const hunk = lineChangeToHunk(
      {
        originalStartLineNumber: 2,
        originalEndLineNumber: 2,
        modifiedStartLineNumber: 2,
        modifiedEndLineNumber: 2,
      },
      "a\nb\nc\n",
      "a\nX\nc\n"
    );
    assert.ok(hunk);
    assert.deepEqual(hunk.baselineLines, ["b"]);
    assert.deepEqual(hunk.currentLines, ["X"]);
  });
});

describe("hunkFingerprint on very large hunks", () => {
  const big = (n: number, marker: string) =>
    Array.from({ length: n }, (_, i) => (i === n - 1 ? marker : `line ${i}`));

  it("still notices a change at the head or the tail", () => {
    const a = hunkFingerprint({
      baselineStart: 0,
      baselineLines: big(5000, "tail A"),
      currentStart: 0,
      currentLines: ["x"],
    });
    const b = hunkFingerprint({
      baselineStart: 0,
      baselineLines: big(5000, "tail B"),
      currentStart: 0,
      currentLines: ["x"],
    });
    assert.notEqual(a, b);
  });

  it("still notices a change in line count", () => {
    const a = hunkFingerprint({
      baselineStart: 0,
      baselineLines: big(5000, "tail"),
      currentStart: 0,
      currentLines: ["x"],
    });
    const b = hunkFingerprint({
      baselineStart: 0,
      baselineLines: big(5001, "tail"),
      currentStart: 0,
      currentLines: ["x"],
    });
    assert.notEqual(a, b);
  });

  it("notices a change in the middle, not just at the edges", () => {
    // This is the one that used to fail. The digest sampled the first and last
    // hundred lines plus the length, so two hunks differing anywhere in between
    // were byte-identical — and every whole-file rewrite is longer than the
    // sample. `CommentReviewController` keys its "has anything changed?" check on
    // exactly these fingerprints and returns early when they match, so the thread
    // went on rendering the previous revision while Keep folded the *current*
    // content into the baseline: the user accepted lines they were never shown.
    const middle = (marker: string) => {
      const lines = big(400, "tail");
      lines[200] = marker;
      return lines;
    };
    const a = hunkFingerprint({
      baselineStart: 0,
      baselineLines: middle("TIMEOUT = 30"),
      currentStart: 0,
      currentLines: ["x"],
    });
    const b = hunkFingerprint({
      baselineStart: 0,
      baselineLines: middle("TIMEOUT = 300"),
      currentStart: 0,
      currentLines: ["x"],
    });
    assert.notEqual(a, b);
  });

  it("stays within its cost budget on a whole-file hunk", () => {
    // Hashing every line costs what it costs; this pins the order of magnitude so
    // a future change cannot make it quietly quadratic. ~24 ms locally for 40k
    // lines on each side, against ~62 ms for the `computeHunks` call that produced
    // the hunk in the first place — the bound below is deliberately loose because
    // a shared CI runner is not a benchmark.
    const shape = {
      baselineStart: 0,
      baselineLines: big(40_000, "tail"),
      currentStart: 0,
      currentLines: big(40_000, "tail2"),
    };
    const started = process.hrtime.bigint();
    hunkFingerprint(shape);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 500, `fingerprinting a 40k-line hunk took ${ms}ms`);
  });
});

describe("computeHunks", () => {
  it("reports nothing for identical texts", () => {
    assert.deepEqual(computeHunks("a\nb\nc", "a\nb\nc"), []);
  });

  it("finds a single replacement", () => {
    const hunks = computeHunks(lines("a", "b", "c"), lines("a", "X", "c"));
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].baselineStart, 1);
    assert.deepEqual(hunks[0].baselineLines, ["b"]);
    assert.equal(hunks[0].currentStart, 1);
    assert.deepEqual(hunks[0].currentLines, ["X"]);
    assert.equal(hunks[0].degraded, undefined);
  });

  it("finds a pure insertion", () => {
    const hunks = computeHunks(lines("a", "c"), lines("a", "b", "c"));
    assert.equal(hunks.length, 1);
    assert.deepEqual(hunks[0].baselineLines, []);
    assert.deepEqual(hunks[0].currentLines, ["b"]);
    assert.equal(hunks[0].currentStart, 1);
  });

  it("finds a pure deletion", () => {
    const hunks = computeHunks(lines("a", "b", "c"), lines("a", "c"));
    assert.equal(hunks.length, 1);
    assert.deepEqual(hunks[0].baselineLines, ["b"]);
    assert.deepEqual(hunks[0].currentLines, []);
    assert.equal(hunks[0].currentStart, 1);
  });

  it("separates distant changes into distinct hunks", () => {
    const before = lines("a", "b", "c", "d", "e", "f");
    const after = lines("a", "B", "c", "d", "E", "f");
    const hunks = computeHunks(before, after);
    assert.equal(hunks.length, 2);
    assert.equal(hunks[0].currentStart, 1);
    assert.equal(hunks[1].currentStart, 4);
  });

  it("handles empty sides", () => {
    assert.deepEqual(computeHunks("", ""), []);
    assert.equal(computeHunks("", "a\nb")[0].currentLines.length, 2);
    assert.equal(computeHunks("a\nb", "")[0].baselineLines.length, 2);
  });

  it("preserves a trailing newline as an empty last line", () => {
    assert.deepEqual(splitLines("a\n"), ["a", ""]);
    assert.deepEqual(computeHunks("a\n", "a\n"), []);
  });

  it("ignores a pure line-ending change", () => {
    assert.deepEqual(computeHunks("a\r\nb", "a\nb"), []);
  });

  it("stays fast on a large file with one changed line", () => {
    const big = Array.from({ length: 40_000 }, (_, i) => `line ${i}`);
    const before = big.join("\n");
    const modified = [...big];
    modified[20_000] = "changed";
    const started = Date.now();
    const hunks = computeHunks(before, modified.join("\n"));
    const elapsed = Date.now() - started;
    assert.equal(hunks.length, 1);
    assert.deepEqual(hunks[0].currentLines, ["changed"]);
    // The old quadratic engine degraded to a single whole-file hunk above
    // 4M cells; this must both stay precise and stay quick.
    assert.ok(elapsed < 2000, `took ${elapsed}ms`);
    assert.equal(hunks[0].degraded, undefined);
  });

  it("marks the fallback path so the UI can say so", () => {
    // Two texts with nothing in common: past the edit-distance cap the whole
    // region is reported as one replacement, and that has to be visible.
    const before = Array.from({ length: 2000 }, (_, i) => `alpha ${i}`).join(
      "\n"
    );
    const after = Array.from({ length: 2000 }, (_, i) => `omega ${i}`).join(
      "\n"
    );
    const hunks = computeHunks(before, after);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].degraded, true);
  });

  it("still diffs precisely when the change is a whole block", () => {
    const before = lines("head", "one", "two", "three", "tail");
    const after = lines("head", "1", "2", "tail");
    const hunks = computeHunks(before, after);
    assert.equal(hunks.length, 1);
    assert.deepEqual(hunks[0].baselineLines, ["one", "two", "three"]);
    assert.deepEqual(hunks[0].currentLines, ["1", "2"]);
  });
});

describe("line units", () => {
  it("round-trips any text exactly", () => {
    for (const text of ["", "a", "a\n", "a\r\nb", "a\nb\r\nc\n", "\n\n"]) {
      assert.equal(fromUnits(toUnits(text)), text, JSON.stringify(text));
    }
  });

  it("records each terminator separately", () => {
    assert.deepEqual(toUnits("a\r\nb\nc"), [
      { content: "a", eol: "\r\n" },
      { content: "b", eol: "\n" },
      { content: "c", eol: "" },
    ]);
  });
});

describe("keep / undo", () => {
  it("round-trips a replacement", () => {
    const baseline = lines("a", "b", "c");
    const current = lines("a", "X", "c");
    const hunk = computeHunks(baseline, current)[0];

    assert.equal(keepHunkInBaseline(baseline, current, hunk), current);
    assert.equal(undoHunkInCurrent(current, baseline, hunk), baseline);
  });

  it("round-trips an insertion and a deletion", () => {
    const inserted = computeHunks(lines("a", "c"), lines("a", "b", "c"))[0];
    assert.equal(
      undoHunkInCurrent(lines("a", "b", "c"), lines("a", "c"), inserted),
      lines("a", "c")
    );
    assert.equal(
      keepHunkInBaseline(lines("a", "c"), lines("a", "b", "c"), inserted),
      lines("a", "b", "c")
    );

    const deleted = computeHunks(lines("a", "b", "c"), lines("a", "c"))[0];
    assert.equal(
      undoHunkInCurrent(lines("a", "c"), lines("a", "b", "c"), deleted),
      lines("a", "b", "c")
    );
    assert.equal(
      keepHunkInBaseline(lines("a", "b", "c"), lines("a", "c"), deleted),
      lines("a", "c")
    );
  });

  it("restores a line deleted at the end of the file", () => {
    const baseline = lines("a", "b");
    const current = "a";
    const hunk = computeHunks(baseline, current)[0];
    assert.equal(undoHunkInCurrent(current, baseline, hunk), baseline);
  });

  it("keeps a trailing newline intact", () => {
    const baseline = "a\nb\n";
    const current = "a\nB\n";
    const hunk = computeHunks(baseline, current)[0];
    assert.equal(undoHunkInCurrent(current, baseline, hunk), baseline);
    assert.equal(keepHunkInBaseline(baseline, current, hunk), current);
  });

  it("does not rewrite the line endings of untouched lines", () => {
    // The old implementation re-joined every line with one detected EOL, so a
    // three-line Undo in a CRLF file rewrote the whole file.
    const baseline = "a\r\nb\r\nc\r\nd";
    const current = "a\r\nB\r\nc\r\nd";
    const hunk = computeHunks(baseline, current)[0];
    assert.equal(undoHunkInCurrent(current, baseline, hunk), baseline);
    assert.equal(keepHunkInBaseline(baseline, current, hunk), current);
  });

  it("preserves mixed line endings outside the hunk", () => {
    const baseline = "a\r\nb\nc\r\nd";
    const current = "a\r\nB\nc\r\nd";
    const hunk = computeHunks(baseline, current)[0];
    const undone = undoHunkInCurrent(current, baseline, hunk);
    assert.equal(undone, baseline);
    // Every terminator, not just the dominant one, survives.
    assert.equal((undone ?? "").split("\r\n").length, 3);
  });

  it("refuses to splice when the current content has moved on", () => {
    const baseline = lines("a", "b", "c");
    const current = lines("a", "X", "c");
    const hunk = computeHunks(baseline, current)[0];

    // The user inserted a line above the hunk: the recorded offsets now point
    // at unrelated content, so applying would corrupt the file.
    const shifted = lines("new", "a", "X", "c");
    assert.equal(undoHunkInCurrent(shifted, baseline, hunk), undefined);
  });

  it("refuses to splice when the baseline has moved on", () => {
    const hunk = computeHunks(lines("a", "b", "c"), lines("a", "X", "c"))[0];
    assert.equal(
      keepHunkInBaseline(lines("z", "z", "z"), lines("a", "X", "c"), hunk),
      undefined
    );
  });

  it("applies every hunk of a multi-change file correctly", () => {
    const baseline = lines("a", "b", "c", "d", "e", "f");
    const current = lines("a", "B", "c", "d", "E", "f");
    const hunks = computeHunks(baseline, current);

    // Undo the later hunk first so the earlier offsets stay valid.
    let text = current;
    for (const hunk of [...hunks].reverse()) {
      const next = undoHunkInCurrent(text, baseline, hunk);
      assert.ok(next !== undefined);
      text = next;
    }
    assert.equal(text, baseline);
  });
});

describe("hunk fingerprints", () => {
  it("is stable for the same content and position", () => {
    const a = computeHunks(lines("a", "b"), lines("a", "X"))[0];
    const b = computeHunks(lines("a", "b"), lines("a", "X"))[0];
    assert.equal(a.fingerprint, b.fingerprint);
  });

  it("changes when the content changes", () => {
    const a = computeHunks(lines("a", "b"), lines("a", "X"))[0];
    const b = computeHunks(lines("a", "b"), lines("a", "Y"))[0];
    assert.notEqual(a.fingerprint, b.fingerprint);
  });

  it("changes when the position changes", () => {
    const at1 = hunkFingerprint({
      baselineStart: 1,
      baselineLines: ["b"],
      currentStart: 1,
      currentLines: ["X"],
    });
    const at2 = hunkFingerprint({
      baselineStart: 2,
      baselineLines: ["b"],
      currentStart: 2,
      currentLines: ["X"],
    });
    assert.notEqual(at1, at2);
  });
});

describe("lineChangeToHunk", () => {
  const baseline = lines("a", "b", "c");

  it("maps a replacement", () => {
    const current = lines("a", "X", "c");
    const hunk = lineChangeToHunk(
      {
        originalStartLineNumber: 2,
        originalEndLineNumber: 2,
        modifiedStartLineNumber: 2,
        modifiedEndLineNumber: 2,
      },
      baseline,
      current
    );
    assert.ok(hunk);
    assert.deepEqual(hunk.baselineLines, ["b"]);
    assert.deepEqual(hunk.currentLines, ["X"]);
    assert.equal(undoHunkInCurrent(current, baseline, hunk), baseline);
  });

  it("maps a pure insertion (originalEnd === 0)", () => {
    const before = lines("a", "c");
    const after = lines("a", "B", "c");
    const hunk = lineChangeToHunk(
      {
        originalStartLineNumber: 1,
        originalEndLineNumber: 0,
        modifiedStartLineNumber: 2,
        modifiedEndLineNumber: 2,
      },
      before,
      after
    );
    assert.ok(hunk);
    assert.deepEqual(hunk.baselineLines, []);
    assert.deepEqual(hunk.currentLines, ["B"]);
    assert.equal(hunk.baselineStart, 1);
    assert.equal(undoHunkInCurrent(after, before, hunk), before);
    assert.equal(keepHunkInBaseline(before, after, hunk), after);
  });

  it("maps a pure deletion (modifiedEnd === 0)", () => {
    const current = lines("a", "c");
    const hunk = lineChangeToHunk(
      {
        originalStartLineNumber: 2,
        originalEndLineNumber: 2,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 0,
      },
      baseline,
      current
    );
    assert.ok(hunk);
    assert.deepEqual(hunk.baselineLines, ["b"]);
    assert.deepEqual(hunk.currentLines, []);
    assert.equal(hunk.currentStart, 1);
    assert.equal(undoHunkInCurrent(current, baseline, hunk), baseline);
  });

  it("rejects coordinates that do not fit the texts", () => {
    assert.equal(
      lineChangeToHunk(
        {
          originalStartLineNumber: 99,
          originalEndLineNumber: 120,
          modifiedStartLineNumber: 1,
          modifiedEndLineNumber: 1,
        },
        baseline,
        lines("a", "c")
      ),
      undefined
    );
  });
});

describe("detectEol", () => {
  it("prefers the dominant terminator", () => {
    assert.equal(detectEol("a\r\nb\r\nc"), "\r\n");
    assert.equal(detectEol("a\nb\nc"), "\n");
    assert.equal(detectEol(""), "\n");
  });
});

describe("lineChangeToHunk honours the reported coordinates", () => {
  it("narrows to the clicked range on a file Claude filled from empty", () => {
    // The empty-baseline shortcut returned the *whole file* regardless of the
    // coordinates, so clicking one bar in the Quick Diff widget of a file Claude
    // had filled from empty accepted — or wiped — all of it, with no dialog,
    // because the change scope skips confirmation by default.
    const current = "a\nb\nc\nd\n";
    const hunk = lineChangeToHunk(
      {
        originalStartLineNumber: 0,
        originalEndLineNumber: 0,
        modifiedStartLineNumber: 2,
        modifiedEndLineNumber: 3,
      },
      "",
      current
    );
    assert.ok(hunk);
    assert.deepEqual(hunk.currentLines, ["b", "c"]);
    assert.equal(hunk.currentStart, 1);
  });

  it("resolves a file Claude emptied, byte-exactly", () => {
    // The mirror of the empty-baseline case had no handling at all: every
    // coordinate shape VS Code can report for an emptied file either failed the
    // range check — so the widget's Undo was refused forever — or produced a hunk
    // whose baseline lines stopped short of the phantom trailing line, so the
    // restored file lost its final newline.
    const baseline = "a\nb\n";
    const shapes = [
      {
        originalStartLineNumber: 1,
        originalEndLineNumber: 2,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 0,
      },
      {
        originalStartLineNumber: 1,
        originalEndLineNumber: 3,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 1,
      },
      {
        originalStartLineNumber: 1,
        originalEndLineNumber: 2,
        modifiedStartLineNumber: 0,
        modifiedEndLineNumber: 0,
      },
    ];
    for (const change of shapes) {
      const hunk = lineChangeToHunk(change, baseline, "");
      assert.ok(hunk, `refused ${JSON.stringify(change)}`);
      assert.equal(
        undoHunkInCurrent("", baseline, hunk),
        baseline,
        `not byte-exact for ${JSON.stringify(change)}`
      );
    }
  });

  it("still matches what the store computed, so the widget can be checked", () => {
    // `keepLineChange`/`undoLineChange` require the derived hunk to sit inside a
    // hunk the store holds. The narrowing above must not break that: a hunk derived
    // from in-sync coordinates has to be covered by the store's own.
    const baseline = "";
    const current = "a\nb\nc\nd\n";
    const stored = computeHunks(baseline, current);
    assert.equal(stored.length, 1);
    const derived = lineChangeToHunk(
      {
        originalStartLineNumber: 0,
        originalEndLineNumber: 0,
        modifiedStartLineNumber: 2,
        modifiedEndLineNumber: 3,
      },
      baseline,
      current
    );
    assert.ok(derived);
    assert.ok(hunkCovers(stored[0], derived));
  });
});

describe("hunkCovers", () => {
  const shape = (
    baselineStart: number,
    baselineLines: string[],
    currentStart: number,
    currentLines: string[]
  ) => ({
    index: 0,
    fingerprint: "x",
    baselineStart,
    baselineLines,
    currentStart,
    currentLines,
  });

  it("accepts a narrower slice of a real difference", () => {
    const outer = shape(0, [], 0, ["a", "b", "c", "d"]);
    assert.ok(hunkCovers(outer, shape(0, [], 1, ["b", "c"])));
  });

  it("rejects a region the store considers unchanged", () => {
    // The stale-widget case: VS Code's change list was computed before Claude
    // inserted three lines near the top, so the coordinates point into a region
    // that is no longer part of any difference. Acting on them deleted the user's
    // lines and duplicated Claude's, and reported "applied".
    const outer = shape(1, [], 1, ["NEW1", "NEW2", "NEW3"]);
    assert.ok(!hunkCovers(outer, shape(5, ["a5", "a6"], 5, ["a2", "a3"])));
  });

  it("accepts an identical hunk", () => {
    const h = shape(3, ["b"], 3, []);
    assert.ok(hunkCovers(h, h));
  });
});

describe("line endings", () => {
  it("keeps the boundary terminator when a splice extends the file", () => {
    // `spliceUnits` filled a newly-interior unit's terminator from the *target*
    // text, and `detectEol` can do no better than "\n" for a text with no
    // terminator at all — which is exactly the shape here, a CRLF file Claude
    // truncated to one line with no final newline. The Undo silently converted that
    // line's terminator, and because the diff is EOL-blind the store then saw no
    // difference and deleted the baseline.
    const baseline = "ZZ\r\n  x\r\nc";
    const current = "ZZ";
    const hunks = computeHunks(baseline, current);
    assert.equal(hunks.length, 1);
    assert.equal(undoHunkInCurrent(current, baseline, hunks[0]), baseline);
  });

  it("represents an EOL-only rewrite as a reviewable hunk", () => {
    // `computeHunks` normalizes CRLF, so this pair diffs to nothing — and "nothing"
    // is what told the store to accept the file and delete its baseline. Claude's
    // Write tool emits LF, so a CRLF file is the ordinary way in.
    const baseline = "a\r\nb\r\nc\r\n";
    const current = "a\nb\nc\n";
    assert.deepEqual(computeHunks(baseline, current), []);

    const hunk = eolOnlyHunk(baseline, current);
    assert.equal(hunk.eolOnly, true);
    assert.equal(
      undoHunkInCurrent(current, baseline, hunk),
      baseline,
      "Undo must restore the original terminators byte for byte"
    );
    assert.equal(
      keepHunkInBaseline(baseline, current, hunk),
      current,
      "Keep must fold them in, so the file then resolves"
    );
  });

  it("restores byte-exactly when an EOL change rides along with a real edit", () => {
    // The compound case: one real edit plus a terminator rewrite. Undoing the hunk
    // restores its own lines with the baseline's terminators and leaves every other
    // line rewritten, so the result is not the baseline — which the store now keeps
    // reviewable instead of reporting as fully restored.
    const baseline = "a\nb\nc\n";
    const current = "a\r\nB\r\nc\r\n";
    const hunks = computeHunks(baseline, current);
    assert.equal(hunks.length, 1);
    const afterHunk = undoHunkInCurrent(current, baseline, hunks[0]);
    assert.notEqual(afterHunk, baseline, "one hunk cannot fix the terminators");

    // …and the whole-file EOL hunk that the store then offers does finish the job.
    assert.deepEqual(computeHunks(baseline, afterHunk!), []);
    assert.equal(
      undoHunkInCurrent(
        afterHunk!,
        baseline,
        eolOnlyHunk(baseline, afterHunk!)
      ),
      baseline
    );
  });
});
