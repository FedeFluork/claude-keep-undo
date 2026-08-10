/**
 * Pure reading of Claude Code transcript lines, and the two judgement calls that
 * decide whether what they say can be believed.
 *
 * Kept free of any `vscode` import for the same reason as reconstruct.ts: this is
 * where "did this tool call actually change the file" is decided, and a wrong
 * answer here is what turns an Undo into data loss. It needs to be executable in
 * a plain unit test.
 */

import { EditEvent } from "./reconstruct";

export interface ToolUseBlock {
  /** Absent in a malformed record; without it a result cannot be correlated. */
  id: string | undefined;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  toolUseId: string;
  /** The tool reported a failure, so the file was not changed. */
  failed: boolean;
}

export interface TranscriptLine {
  /** The line's own timestamp in epoch milliseconds, if it has a usable one. */
  timestamp: number | undefined;
  uses: ToolUseBlock[];
  results: ToolResultBlock[];
}

/**
 * Split one transcript line into the tool calls it announces and the results it
 * reports.
 *
 * Results are the half that used to be invisible: they live in a *user* message,
 * and the watcher only ever looked at `tool_use` blocks. Without them a call that
 * Claude Code refused ("String to replace not found in file") or that the user
 * denied at the permission prompt was ingested exactly like one that landed.
 */
export function parseTranscriptLine(line: string): TranscriptLine | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = obj as {
    message?: { content?: unknown };
    timestamp?: unknown;
  };
  const content = record?.message?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const uses: ToolUseBlock[] = [];
  const results: ToolResultBlock[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typed = block as Record<string, unknown>;
    if (typed.type === "tool_use") {
      if (typeof typed.name === "string" && isRecord(typed.input)) {
        uses.push({
          id: typeof typed.id === "string" ? typed.id : undefined,
          name: typed.name,
          input: typed.input,
        });
      }
    } else if (typed.type === "tool_result") {
      if (typeof typed.tool_use_id === "string") {
        results.push({
          toolUseId: typed.tool_use_id,
          failed: isErrorResult(typed),
        });
      }
    }
  }
  return { timestamp: parseTimestamp(record.timestamp), uses, results };
}

/**
 * Did this tool_result report a failure?
 *
 * `is_error` is the documented signal but it is not always present: Claude Code
 * also carries the failure as a `<tool_use_error>` prefix inside the result
 * content, so both have to be checked or a refused edit reads as a successful
 * one.
 */
export function isErrorResult(block: Record<string, unknown>): boolean {
  if (block.is_error === true) {
    return true;
  }
  return resultText(block.content).includes("<tool_use_error>");
}

/** The edit a file-mutating tool call performs, or undefined for anything else. */
export function editEventFor(
  name: string,
  input: Record<string, unknown>
): EditEvent | undefined {
  if (name === "Edit") {
    return {
      kind: "edit",
      oldString: asString(input.old_string),
      newString: asString(input.new_string),
      replaceAll: !!input.replace_all,
    };
  }
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    return {
      kind: "multiedit",
      edits: (input.edits as Record<string, unknown>[]).map((e) => ({
        oldString: asString(e?.old_string),
        newString: asString(e?.new_string),
        replaceAll: !!e?.replace_all,
      })),
    };
  }
  return name === "Write" ? { kind: "write" } : undefined;
}

/** The file path a tool call names, verbatim (still possibly relative). */
export function filePathOf(input: Record<string, unknown>): string | undefined {
  if (typeof input.file_path === "string" && input.file_path) {
    return input.file_path;
  }
  return typeof input.filePath === "string" && input.filePath
    ? input.filePath
    : undefined;
}

/**
 * What the file looked like when a `Write` was announced, plus the evidence that
 * decides whether it can be believed.
 */
export interface WriteSnapshotFacts {
  /** undefined means the file did not exist: the Write creates it. */
  content: string | undefined;
  /** When we read it. */
  ts: number;
  /** The file's mtime at that moment, or undefined if it was not there. */
  mtimeMs: number | undefined;
  /** The timestamp of the transcript line announcing the write. */
  toolTs: number | undefined;
}

export type WriteTrust =
  | { kind: "baseline"; baseline: string; created: boolean }
  | { kind: "reject"; reason: string };

/**
 * Decide whether a captured pre-`Write` snapshot is really the pre-write state.
 *
 * The whole `Write` strategy rests on the tool_use line being *observed* before
 * the tool runs, and it is not: it is observed whenever the poll or the directory
 * watcher next fires, which can be half a minute later — and a project whose
 * session directory does not exist yet has no watcher at all. By then the write
 * may have landed, and what we read is Claude's own output.
 *
 * Testing "the content differs from what is on disk now" does not catch that: a
 * follow-up edit in the same burst makes Claude's first draft differ from
 * `current` too, and registering it as the baseline silently replaces the user's
 * file with it. So require the file's own mtime to predate the tool call.
 */
export function trustWriteSnapshot(
  snapshot: WriteSnapshotFacts,
  current: string,
  now: number,
  ttlMs: number
): WriteTrust {
  if (now - snapshot.ts >= ttlMs) {
    // Older than any tool call it could describe. Trusting it is how a file that
    // exists gets reported as one Claude created — and then deleted.
    return { kind: "reject", reason: "the snapshot outlived its tool call" };
  }
  if (snapshot.content === undefined) {
    // The file did not exist when the Write was announced. That is evidence in
    // itself — Claude's output cannot be an absent file — so no timing proof is
    // needed: the whole file is an addition.
    return current === ""
      ? { kind: "reject", reason: "the file is still empty" }
      : { kind: "baseline", baseline: "", created: true };
  }
  if (snapshot.content === current) {
    // Either the write has not landed yet, or we read the file after it landed and
    // it has not moved since. Indistinguishable, and guessing means offering an
    // Undo that empties the file.
    return {
      kind: "reject",
      reason: "the file has not changed away from the snapshot",
    };
  }
  if (snapshot.mtimeMs === undefined || snapshot.toolTs === undefined) {
    return {
      kind: "reject",
      reason: "its capture time cannot be proven to precede the tool call",
    };
  }
  if (snapshot.mtimeMs >= snapshot.toolTs) {
    return {
      kind: "reject",
      reason:
        "the file was already modified when the tool call was announced, so the content read is Claude's own",
    };
  }
  return { kind: "baseline", baseline: snapshot.content, created: false };
}

/** A tool_result's content is either a string or an array of content blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) =>
      block && typeof block === "object"
        ? asString((block as { text?: unknown }).text)
        : ""
    )
    .join("\n");
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
