import * as vscode from "vscode";
import { ChangeStore } from "../changeStore";
import { hunkLineRange } from "../diff";
import { quickFixMode } from "../settings";
import { pluralChanges, summarizeHunk } from "./format";

/**
 * Offers Keep/Undo as Quick Fixes on the hunk under the cursor, so the review
 * has a lightbulb and a `Ctrl+.` / `Cmd+.` keyboard path in the ordinary editor
 * — no diff tab, no widget, no mouse.
 *
 * Nothing is offered unless the cursor is actually inside one of Claude's
 * changes. Quick Fix is a muscle-memory menu — people press `Ctrl+.`, `Enter` —
 * so a whole-file Undo listed next to *Add missing import* on an ESLint error
 * four hundred lines away is a hazard, not a convenience.
 */
export class ClaudeCodeActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  constructor(private readonly store: ChangeStore) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): vscode.CodeAction[] {
    const mode = quickFixMode();
    if (mode === "off" || document.uri.scheme !== "file") {
      return [];
    }
    const absPath = document.uri.fsPath;
    const tracked = this.store.get(absPath);
    if (!tracked) {
      return [];
    }

    const actions: vscode.CodeAction[] = [];
    tracked.hunks.forEach((hunk, index) => {
      const { start, end } = hunkLineRange(hunk);
      // A pure deletion occupies no line of its own; accept the line above too.
      const from =
        hunk.currentLines.length > 0 ? start : Math.max(0, start - 1);
      if (range.end.line < from || range.start.line > end) {
        return;
      }
      actions.push(
        makeAction(
          `Keep this Claude change (${summarizeHunk(hunk)})`,
          "claudeKeepUndo.keepHunk",
          [absPath, index, hunk.fingerprint],
          true
        ),
        makeAction("Undo this Claude change", "claudeKeepUndo.undoHunk", [
          absPath,
          index,
          hunk.fingerprint,
        ])
      );
    });

    // Scoped to the cursor being inside a change, exactly like the per-hunk
    // actions above: outside one, this file's Quick Fix list is untouched.
    if (actions.length > 0 && mode === "hunkAndFile") {
      actions.push(
        makeAction(
          `Keep all Claude changes in this file (${pluralChanges(
            tracked.hunks.length
          )})`,
          "claudeKeepUndo.keepFile",
          [absPath]
        ),
        makeAction(
          "Undo all Claude changes in this file",
          "claudeKeepUndo.undoFile",
          [absPath]
        )
      );
    }
    return actions;
  }
}

function makeAction(
  title: string,
  command: string,
  args: unknown[],
  preferred = false
): vscode.CodeAction {
  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  action.command = { command, title, arguments: args };
  action.isPreferred = preferred;
  return action;
}
