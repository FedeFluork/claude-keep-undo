import * as vscode from "vscode";
import { ChangeStore } from "../changeStore";
import { Hunk, hunkLineRange } from "../diff";
import { BASELINE_SCHEME } from "../util";
import { summarizeHunk } from "./format";

/**
 * Move to the next / previous change in the current file.
 *
 * There were commands to *act* on a change and none to *find* one, so reviewing
 * a long file meant scrolling and hunting for gutter bars. Git ships
 * `editor.action.dirtydiff.next`; this is the same idea against our baseline,
 * and together with Keep/Undo on the keyboard it closes the loop into
 * next → read → decide → next.
 */
export async function goToChange(
  store: ChangeStore,
  direction: 1 | -1
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  if (editor.document.uri.scheme === BASELINE_SCHEME) {
    void vscode.window.showInformationMessage(
      "Move through the changes on the right-hand side of the diff — the file itself."
    );
    return;
  }
  if (editor.document.uri.scheme !== "file") {
    return;
  }

  const absPath = editor.document.uri.fsPath;
  const tracked = store.get(absPath);
  if (!tracked || tracked.hunks.length === 0) {
    await offerAnotherFile(store, absPath);
    return;
  }

  const hunks = [...tracked.hunks].sort(
    (a, b) => a.currentStart - b.currentStart
  );
  const line = editor.selection.active.line;
  const index = pick(hunks, line, direction);
  const hunk = hunks[index];
  const { start, end } = hunkLineRange(hunk);
  const lastLine = Math.max(0, editor.document.lineCount - 1);
  const from = new vscode.Position(Math.min(start, lastLine), 0);
  const to = editor.document.lineAt(Math.min(end, lastLine)).range.end;

  editor.selection = new vscode.Selection(from, from);
  editor.revealRange(
    new vscode.Range(from, to),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport
  );
  vscode.window.setStatusBarMessage(
    `Claude change ${index + 1} of ${hunks.length} · ${summarizeHunk(hunk)}`,
    4000
  );
}

/**
 * Which hunk to land on. Both directions wrap, so holding the shortcut walks
 * the file in a circle instead of stopping silently at the last change.
 */
function pick(hunks: Hunk[], line: number, direction: 1 | -1): number {
  if (direction === 1) {
    const next = hunks.findIndex((h) => h.currentStart > line);
    return next === -1 ? 0 : next;
  }
  for (let i = hunks.length - 1; i >= 0; i--) {
    if (hunks[i].currentStart < line) {
      return i;
    }
  }
  return hunks.length - 1;
}

/** Nothing here — but say where there *is* something, rather than just "no". */
async function offerAnotherFile(
  store: ChangeStore,
  absPath: string
): Promise<void> {
  const others = store.getTracked().filter((f) => f.path !== absPath);
  if (others.length === 0) {
    void vscode.window.showInformationMessage(
      "No Claude changes are awaiting review."
    );
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `No Claude changes in this file. ${
      others.length === 1 ? "One other file is" : `${others.length} files are`
    } awaiting review.`,
    "Review them"
  );
  if (choice === "Review them") {
    await vscode.commands.executeCommand("claudeKeepUndo.openAllChanges");
  }
}
