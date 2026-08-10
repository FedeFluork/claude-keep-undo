import { Hunk } from "../diff";

/** Compact size of a hunk, e.g. `+3 −1`. */
export function summarizeHunk(hunk: Hunk): string {
  if (hunk.eolOnly) {
    // Both sides hold the same lines, so `+N −N` would be true and useless.
    return EOL_ONLY_LABEL;
  }
  const parts: string[] = [];
  if (hunk.currentLines.length) {
    parts.push(`+${hunk.currentLines.length}`);
  }
  if (hunk.baselineLines.length) {
    parts.push(`−${hunk.baselineLines.length}`);
  }
  return parts.join(" ") || "change";
}

/** `1 change` / `4 changes`. */
export function pluralChanges(count: number): string {
  return `${count} ${count === 1 ? "change" : "changes"}`;
}

/** `1 file` / `4 files`. */
export function pluralFiles(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

/**
 * The one name for the state where the two versions were too different to split
 * into separate hunks, and the one explanation of it.
 *
 * Every surface that mentions it uses these — a state described four different
 * ways reads as four different states.
 */
export const WHOLE_FILE_LABEL = "whole file rewritten";
export const WHOLE_FILE_EXPLANATION =
  "The old and new versions had too little in common to split into separate changes, so the whole region is treated as one change.";

/**
 * The same, for a file whose lines are unchanged but whose line terminators are
 * not. The diff is line-based and deliberately EOL-insensitive, so there is
 * nothing to show per line — but the bytes on disk did change, and Undo File puts
 * the original terminators back.
 */
export const EOL_ONLY_LABEL = "line endings changed";
export const EOL_ONLY_EXPLANATION =
  "Every line is unchanged, but the line terminators are not — the file was rewritten with different line endings. Undo restores the original ones.";

/** Unified-diff preview of a hunk, capped so a huge rewrite stays readable. */
export function hunkDiffText(hunk: Hunk, maxLines = 60): string {
  if (hunk.eolOnly) {
    return EOL_ONLY_EXPLANATION;
  }
  const lines = [
    ...hunk.baselineLines.map((l) => `- ${l}`),
    ...hunk.currentLines.map((l) => `+ ${l}`),
  ];
  if (lines.length <= maxLines) {
    return lines.join("\n");
  }
  const head = lines.slice(0, maxLines);
  head.push(`… ${lines.length - maxLines} more lines`);
  return head.join("\n");
}

/** The first non-blank line of a hunk, for a one-line preview of its content. */
export function hunkPreview(hunk: Hunk, maxLength = 72): string {
  const line =
    [...hunk.currentLines, ...hunk.baselineLines].find(
      (l) => l.trim().length > 0
    ) ?? "";
  const text = line.trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
