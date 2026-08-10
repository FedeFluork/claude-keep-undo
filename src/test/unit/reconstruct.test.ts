import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EditEvent,
  forwardApply,
  reconstructBaseline,
  replayForward,
  reverseApply,
} from "../../detection/reconstruct";

const edit = (
  oldString: string,
  newString: string,
  replaceAll = false
): EditEvent => ({ kind: "edit", oldString, newString, replaceAll });

describe("reverseApply", () => {
  it("puts the original text back", () => {
    assert.deepEqual(
      reverseApply("hello brave world", {
        oldString: "cruel",
        newString: "brave",
        replaceAll: false,
      }),
      { kind: "ok", content: "hello cruel world" }
    );
  });

  it("refuses a deletion, which has no anchor to restore to", () => {
    // The edit removed "b " and left nothing behind; putting it back anywhere
    // would be fabrication, and the resulting baseline would hide the deletion.
    assert.equal(
      reverseApply("a c", { oldString: "b ", newString: "", replaceAll: false })
        .kind,
      "fail"
    );
  });

  it("refuses when the replacement text is not present", () => {
    assert.equal(
      reverseApply("nothing here", {
        oldString: "x",
        newString: "y",
        replaceAll: false,
      }).kind,
      "fail"
    );
  });

  it("refuses when the replacement text is ambiguous", () => {
    // Two candidate positions produce two different baselines that both replay
    // to this content, so no amount of verification can pick the right one.
    const result = reverseApply("x and x", {
      oldString: "unique-old",
      newString: "x",
      replaceAll: false,
    });
    assert.equal(result.kind, "fail");
    assert.match(result.kind === "fail" ? result.reason : "", /ambiguous/);
  });

  it("refuses replaceAll, whose occurrence count is not recorded", () => {
    // This used to assert `{kind:"ok", content:"x x x"}`, i.e. it encoded the
    // assumption that every occurrence of the replacement text was produced by
    // the edit. Any occurrence the user had written themselves is rewritten too,
    // and the forward proof cannot catch it: replaying replace_all forward maps
    // the genuine and the fabricated occurrences alike back to the new string.
    const result = reverseApply("y y y", {
      oldString: "x",
      newString: "y",
      replaceAll: true,
    });
    assert.equal(result.kind, "fail");
    assert.match(result.kind === "fail" ? result.reason : "", /replace_all/);
  });

  it("accepts a replaceAll that changed nothing", () => {
    // old === new: the content is the same either way, whatever the count.
    assert.deepEqual(
      reverseApply("y y y", {
        oldString: "y",
        newString: "y",
        replaceAll: true,
      }),
      { kind: "ok", content: "y y y" }
    );
  });
});

describe("forwardApply", () => {
  it("requires a unique match for a non-replaceAll edit", () => {
    assert.equal(
      forwardApply("a a", {
        oldString: "a",
        newString: "b",
        replaceAll: false,
      }),
      undefined
    );
    assert.equal(
      forwardApply("a z", {
        oldString: "a",
        newString: "b",
        replaceAll: false,
      }),
      "b z"
    );
  });

  it("replays a whole event list", () => {
    const events = [edit("one", "1"), edit("two", "2")];
    assert.equal(replayForward(events, "one two"), "1 2");
  });

  it("cannot replay a Write", () => {
    assert.equal(replayForward([{ kind: "write" }], "anything"), undefined);
  });
});

describe("reconstructBaseline", () => {
  it("recovers the original through a chain of edits", () => {
    const original = "const a = 1;\nconst b = 2;\n";
    const events = [
      edit("const a = 1;", "const a = 10;"),
      edit("const b = 2;", "const b = 20;"),
    ];
    const current = "const a = 10;\nconst b = 20;\n";

    const result = reconstructBaseline(events, current);
    assert.equal(result.kind, "ok");
    assert.equal(result.kind === "ok" && result.baseline, original);
  });

  it("recovers through a MultiEdit, respecting edit order", () => {
    const events: EditEvent[] = [
      {
        kind: "multiedit",
        edits: [
          { oldString: "alpha", newString: "ALPHA", replaceAll: false },
          { oldString: "beta", newString: "BETA", replaceAll: false },
        ],
      },
    ];
    const result = reconstructBaseline(events, "ALPHA and BETA");
    assert.equal(result.kind, "ok");
    assert.equal(result.kind === "ok" && result.baseline, "alpha and beta");
  });

  it("reports a Write as unrecoverable instead of inventing an empty baseline", () => {
    // The old behaviour returned "" here, which made Undo truncate the file.
    const result = reconstructBaseline(
      [{ kind: "write" }],
      "real file content"
    );
    assert.equal(result.kind, "unrecoverable");
  });

  it("reports a deletion as unrecoverable", () => {
    const result = reconstructBaseline(
      [edit("remove me\n", "")],
      "what is left\n"
    );
    assert.equal(result.kind, "unrecoverable");
  });

  it("rejects an ambiguous reverse step rather than guessing a position", () => {
    // "x" occurs twice after the edit. Both candidate baselines replay forward
    // to exactly this content, so verification cannot separate them — the only
    // safe answer is to refuse and let the hooks supply an exact baseline.
    const result = reconstructBaseline([edit("unique-old", "x")], "x and x");
    assert.equal(result.kind, "unrecoverable");
  });

  it("rejects a reconstruction that does not replay back to the current content", () => {
    // The recorded edit cannot have produced this content: `old` is still there
    // afterwards, so replaying is ambiguous and the result must not be trusted.
    const result = reconstructBaseline(
      [edit("old", "new")],
      "new and old remain"
    );
    assert.equal(result.kind, "unrecoverable");
  });

  it("accepts an ambiguous-looking reconstruction that does verify", () => {
    const events = [edit("old", "new")];
    const result = reconstructBaseline(events, "new stuff");
    assert.equal(result.kind, "ok");
    assert.equal(result.kind === "ok" && result.baseline, "old stuff");
  });

  it("reports an empty event list as unrecoverable", () => {
    assert.equal(reconstructBaseline([], "anything").kind, "unrecoverable");
  });

  it("refuses a replace_all rather than fabricating a baseline that verifies", () => {
    // The reproduction from the review, and the reason no test on `current` can
    // decide it. Disk before Claude: "foo\nbar\n" — the second line is the user's
    // own `bar`. Claude runs Edit{foo -> bar, replace_all}. Disk is now
    // "bar\nbar\n" and the old code reconstructed "foo\nfoo\n", which replays
    // forward to exactly "bar\nbar\n" and so passed verification. Undo then wrote
    // `foo` over a line Claude never touched, and the real `bar` existed nowhere.
    const result = reconstructBaseline(
      [edit("foo", "bar", /*replaceAll*/ true)],
      "bar\nbar\n"
    );
    assert.equal(result.kind, "unrecoverable");
  });

  it("refuses a replace_all even when it is the only plausible reading", () => {
    // Refusing across the board is the point: "y y y" from x -> y really might
    // have been "x x x", but nothing in the transcript says so, and this module's
    // rule is never to guess. The file falls back to the hook baseline.
    assert.equal(
      reconstructBaseline([edit("x", "y", true)], "y y y").kind,
      "unrecoverable"
    );
  });
});
