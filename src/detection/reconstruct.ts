/**
 * Pure baseline reconstruction from Claude Code transcript events.
 *
 * Kept free of any `vscode` import so it can be unit tested directly: this is
 * the code that decides what a file looked like *before* Claude touched it, and
 * a wrong answer here is what turns an Undo into data loss.
 *
 * The guiding rule is **never guess**. Every reconstruction is verified by
 * replaying the recorded edits forward over the candidate baseline and checking
 * that the result is byte-identical to what is on disk now. Anything that does
 * not verify is reported as unrecoverable, and the caller falls back to the
 * hooks rather than showing the user a plausible-looking lie.
 */

export interface SingleEdit {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

/** A file-mutating tool call seen in the transcript, in forward order. */
export type EditEvent =
  | ({ kind: "edit" } & SingleEdit)
  | { kind: "multiedit"; edits: SingleEdit[] }
  | { kind: "write" };

export type Reconstruction =
  { kind: "ok"; baseline: string } | { kind: "unrecoverable"; reason: string };

/** Flatten an event into the individual edits it performs, in forward order. */
function editsOf(event: EditEvent): SingleEdit[] {
  if (event.kind === "edit") {
    return [event];
  }
  return event.kind === "multiedit" ? event.edits : [];
}

export type ReverseResult =
  { kind: "ok"; content: string } | { kind: "fail"; reason: string };

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) {
      return count;
    }
    count++;
    from = idx + needle.length;
  }
}

/**
 * Undo one edit: turn the post-edit content back into the pre-edit content.
 *
 * Fails rather than guessing when:
 *  - a deletion (`newString === ""`) leaves no anchor at all, so the removed
 *    text cannot be put back where it came from;
 *  - the edit was a `replace_all`, because the transcript does not record how
 *    many occurrences it replaced (see below);
 *  - the replacement text is not present, so this is not the content this edit
 *    produced;
 *  - the replacement text appears more than once, so which occurrence this edit
 *    produced is unknowable. Picking one can yield a baseline that still
 *    replays correctly while placing the change in the wrong part of the file,
 *    which the forward verification cannot catch.
 */
export function reverseApply(content: string, edit: SingleEdit): ReverseResult {
  const { oldString, newString, replaceAll } = edit;
  if (newString === "") {
    // The edit deleted `oldString`. Nothing in the post-edit content marks where
    // it used to be, so re-inserting it anywhere would be fabrication.
    return {
      kind: "fail",
      reason: "a deletion cannot be located in the post-edit content",
    };
  }
  if (oldString === newString) {
    // A no-op edit: the content is unchanged either way, whether or not it was
    // a replace_all. This is the one provable case.
    return { kind: "ok", content };
  }
  if (replaceAll) {
    // `content.split(newString).join(oldString)` assumes every occurrence of
    // `newString` was produced by this edit. Any occurrence the user had written
    // themselves is rewritten to `oldString` — and the forward proof cannot
    // catch it, because replaying `replace_all` forward maps the genuine and the
    // fabricated occurrences alike back to `newString`.
    //
    // Nothing on the current content can decide it: whether `newString` existed
    // before the edit is simply not recorded, and Claude Code's tool_result for
    // a replace_all says only "All occurrences were successfully replaced" —
    // never a count. So refuse, and let the file fall through to the hook
    // baseline or to the unreviewable list. `foo -> bar` over `foo\nbar\n` used
    // to produce the baseline `foo\nfoo\n` and offer an Undo that rewrote a line
    // the user wrote and Claude never touched.
    return {
      kind: "fail",
      reason:
        "a replace_all edit is not reversible: whether the replacement text already existed elsewhere in the file is not recorded",
    };
  }
  const occurrences = countOccurrences(content, newString);
  if (occurrences === 0) {
    return {
      kind: "fail",
      reason: "the recorded replacement text is no longer present",
    };
  }
  if (occurrences > 1) {
    return {
      kind: "fail",
      reason:
        "the replacement text occurs more than once, so its position is ambiguous",
    };
  }
  const idx = content.indexOf(newString);
  return {
    kind: "ok",
    content:
      content.slice(0, idx) + oldString + content.slice(idx + newString.length),
  };
}

/**
 * Redo one edit, with the same uniqueness requirement Claude Code's `Edit` tool
 * enforces: a non-`replaceAll` edit must match exactly once.
 */
export function forwardApply(
  content: string,
  edit: SingleEdit
): string | undefined {
  const { oldString, newString, replaceAll } = edit;
  if (oldString === newString) {
    return content;
  }
  if (replaceAll) {
    if (!content.includes(oldString)) {
      return undefined;
    }
    return content.split(oldString).join(newString);
  }
  const idx = content.indexOf(oldString);
  if (idx < 0) {
    return undefined;
  }
  if (content.indexOf(oldString, idx + 1) >= 0) {
    return undefined; // ambiguous: the tool would have refused this edit
  }
  return (
    content.slice(0, idx) + newString + content.slice(idx + oldString.length)
  );
}

/** Replay every recorded edit over a candidate baseline, in forward order. */
export function replayForward(
  events: EditEvent[],
  baseline: string
): string | undefined {
  let content = baseline;
  for (const event of events) {
    if (event.kind === "write") {
      return undefined; // a whole-file write cannot be replayed
    }
    for (const edit of editsOf(event)) {
      const next = forwardApply(content, edit);
      if (next === undefined) {
        return undefined;
      }
      content = next;
    }
  }
  return content;
}

/**
 * Walk the recorded edits backwards over the current content to recover the
 * original, then prove the result by replaying forward.
 *
 * A `Write` is never reconstructable from the transcript alone: the content it
 * overwrote is simply not recorded anywhere. The caller handles that case by
 * snapshotting the file when it first sees the tool call, and by falling back to
 * the hooks otherwise.
 */
export function reconstructBaseline(
  events: EditEvent[],
  current: string
): Reconstruction {
  if (events.length === 0) {
    return { kind: "unrecoverable", reason: "no recorded edits" };
  }
  let content = current;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === "write") {
      return {
        kind: "unrecoverable",
        reason: "a whole-file Write is not reversible from the transcript",
      };
    }
    const edits = editsOf(event);
    for (let j = edits.length - 1; j >= 0; j--) {
      const step = reverseApply(content, edits[j]);
      if (step.kind === "fail") {
        return { kind: "unrecoverable", reason: step.reason };
      }
      content = step.content;
    }
  }

  // Proof: replaying the same edits forward must reproduce exactly what is on
  // disk. Anything that does not is a reconstruction we would have shown the
  // user as fact.
  if (replayForward(events, content) !== current) {
    return {
      kind: "unrecoverable",
      reason: "reconstruction did not reproduce the current content",
    };
  }
  return { kind: "ok", baseline: content };
}
