import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TranscriptOffsets } from "../../detection/transcriptOffsets";

/**
 * The rule these tests pin down is the one that decides whether a transcript is
 * history to skip or a live session to read. Getting it wrong is silent: no
 * warning, no "not reviewable" row, just edits that never appear.
 */

const sizes: Record<string, number> = {
  "/s/old.jsonl": 4096,
  "/s/new.jsonl": 900,
  "/s/later.jsonl": 512,
};
const sizeOf = (f: string) => sizes[f] ?? 0;

describe("TranscriptOffsets", () => {
  it("attaches at the end of transcripts that already existed", () => {
    const offsets = new TranscriptOffsets();
    offsets.sync(["/s/old.jsonl"], sizeOf);
    // Resuming an older session must not replay its whole history into the
    // review queue.
    assert.equal(offsets.get("/s/old.jsonl"), 4096);
  });

  it("reads a transcript that appears later from the beginning", () => {
    const offsets = new TranscriptOffsets();
    offsets.sync(["/s/old.jsonl"], sizeOf);
    offsets.sync(["/s/old.jsonl", "/s/new.jsonl"], sizeOf);
    assert.equal(offsets.get("/s/old.jsonl"), 4096);
    assert.equal(offsets.get("/s/new.jsonl"), 0);
  });

  it("treats an empty first sweep as the first sweep", () => {
    // The regression this class exists for. In a project that has never run
    // Claude Code the session directory does not exist, so the early sweeps come
    // back empty. If an empty sweep did not count, the transcript of the session
    // the user is about to start would be classified as history and skipped —
    // exactly the advertised zero-config first run, silently doing nothing.
    const offsets = new TranscriptOffsets();
    offsets.sync([], sizeOf);
    offsets.sync(["/s/new.jsonl"], sizeOf);
    assert.equal(offsets.get("/s/new.jsonl"), 0);
  });

  it("keeps counting an empty sweep even after several of them", () => {
    const offsets = new TranscriptOffsets();
    offsets.sync([], sizeOf);
    offsets.sync([], sizeOf);
    offsets.sync([], sizeOf);
    offsets.sync(["/s/later.jsonl"], sizeOf);
    assert.equal(offsets.get("/s/later.jsonl"), 0);
  });

  it("never rewinds a file it is already following", () => {
    const offsets = new TranscriptOffsets();
    offsets.sync(["/s/old.jsonl"], sizeOf);
    offsets.set("/s/old.jsonl", 5000); // consumed past the original size
    offsets.sync(["/s/old.jsonl"], sizeOf);
    assert.equal(offsets.get("/s/old.jsonl"), 5000);
  });

  it("reports an unknown file as offset zero", () => {
    const offsets = new TranscriptOffsets();
    assert.equal(offsets.get("/s/unknown.jsonl"), 0);
    assert.equal(offsets.attached, false);
    assert.equal(offsets.size, 0);
  });

  it("records that it has swept, and how many files it follows", () => {
    const offsets = new TranscriptOffsets();
    offsets.sync(["/s/old.jsonl", "/s/new.jsonl"], sizeOf);
    assert.equal(offsets.attached, true);
    assert.equal(offsets.size, 2);
  });
});
