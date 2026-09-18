import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hunk } from "../../diff";
import { currentHunkIndex, neighborHunkIndex } from "../../ui/hunkNav";

function hunk(currentStart: number, lineCount: number): Hunk {
  return {
    index: 0,
    fingerprint: "",
    baselineStart: currentStart,
    baselineLines: ["old"],
    currentStart,
    currentLines: Array.from({ length: lineCount }, (_, i) => `l${i}`),
  };
}

describe("currentHunkIndex", () => {
  const hunks = [hunk(1, 1), hunk(8, 3)];

  it("returns the hunk that contains the line", () => {
    assert.equal(currentHunkIndex(hunks, 1), 0);
    assert.equal(currentHunkIndex(hunks, 8), 1);
    assert.equal(currentHunkIndex(hunks, 10), 1);
  });

  it("picks the nearest hunk when the line sits between them", () => {
    assert.equal(currentHunkIndex(hunks, 0), 0);
    assert.equal(currentHunkIndex(hunks, 3), 0);
    assert.equal(currentHunkIndex(hunks, 6), 1);
    assert.equal(currentHunkIndex(hunks, 20), 1);
  });

  it("treats a pure deletion as the single line it occupies", () => {
    const deleted = hunk(4, 0);
    assert.equal(currentHunkIndex([deleted], 4), 0);
    assert.equal(currentHunkIndex([deleted], 2), 0);
  });
});

describe("neighborHunkIndex", () => {
  const hunks = [hunk(1, 1), hunk(8, 1), hunk(20, 1)];

  it("steps forward and backward in file order", () => {
    assert.equal(neighborHunkIndex(hunks, 0, 1), 1);
    assert.equal(neighborHunkIndex(hunks, 1, 1), 2);
    assert.equal(neighborHunkIndex(hunks, 1, -1), 0);
  });

  it("wraps at both ends", () => {
    assert.equal(neighborHunkIndex(hunks, 2, 1), 0);
    assert.equal(neighborHunkIndex(hunks, 0, -1), 2);
  });
});
