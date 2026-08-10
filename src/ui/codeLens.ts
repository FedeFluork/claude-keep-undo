import * as vscode from "vscode";
import { ChangeStore } from "../changeStore";
import { codeLensMode, codeLensStyle } from "../settings";
import { BASELINE_SCHEME } from "../util";
import { WHOLE_FILE_LABEL, pluralChanges, summarizeHunk } from "./format";

/**
 * Per-hunk "Keep | Undo" actions rendered inline above each change (plus a file
 * summary with Keep all / Undo all).
 *
 * Every row displaces a line of code, so where they appear is a setting
 * (`claudeKeepUndo.codeLens`) and the default is `diffOnly`: in the ordinary
 * editor the review is already served by the gutter bars, the Quick Diff widget
 * and the Quick Fixes, while inside the diff editor there is nothing else.
 */
export class ClaudeCodeLensProvider
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly store: ChangeStore) {
    this.disposables.push(
      store.onDidChange(() => this._onDidChange.fire()),
      // In `diffOnly` mode the answer depends on which tabs are open, so the
      // lenses have to be recomputed when that changes — otherwise opening the
      // diff of a file that is already visible would show none.
      vscode.window.tabGroups.onDidChangeTabs(() => this._onDidChange.fire()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("claudeKeepUndo.codeLens") ||
          e.affectsConfiguration("claudeKeepUndo.codeLensStyle")
        ) {
          this._onDidChange.fire();
        }
      })
    );
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme !== "file") {
      return [];
    }
    const mode = codeLensMode();
    if (mode === "off") {
      return [];
    }
    const absPath = document.uri.fsPath;
    if (mode === "diffOnly" && !isOpenInClaudeDiff(absPath)) {
      return [];
    }
    const tracked = this.store.get(absPath);
    if (!tracked) {
      return [];
    }
    const lastLine = Math.max(0, document.lineCount - 1);
    const lenses: vscode.CodeLens[] = [];
    const keep = codeLensStyle() === "emoji" ? "✅ Keep" : "Keep";
    const undo = codeLensStyle() === "emoji" ? "❌ Undo" : "Undo";

    // The file summary is only worth a row when there is more than one hunk:
    // with a single hunk "Keep all" is the same action as "Keep", and if that
    // hunk starts at line 0 both sets would render on the same row.
    if (tracked.hunks.length > 1) {
      const summaryRange = new vscode.Range(0, 0, 0, 0);
      const label = tracked.degraded
        ? `Claude: 1 change (${WHOLE_FILE_LABEL})`
        : `Claude: ${pluralChanges(tracked.hunks.length)}`;
      lenses.push(
        new vscode.CodeLens(summaryRange, {
          title: label,
          command: "claudeKeepUndo.openDiff",
          arguments: [absPath],
        }),
        new vscode.CodeLens(summaryRange, {
          title: `${keep} all`,
          command: "claudeKeepUndo.keepFile",
          arguments: [absPath],
        }),
        new vscode.CodeLens(summaryRange, {
          title: `${undo} all`,
          command: "claudeKeepUndo.undoFile",
          arguments: [absPath],
        })
      );
    }

    tracked.hunks.forEach((hunk, index) => {
      const line = Math.min(Math.max(0, hunk.currentStart), lastLine);
      const range = new vscode.Range(line, 0, line, 0);
      lenses.push(
        new vscode.CodeLens(range, {
          title: `${keep} (${summarizeHunk(hunk)}${
            hunk.degraded ? `, ${WHOLE_FILE_LABEL}` : ""
          })`,
          command: "claudeKeepUndo.keepHunk",
          // The fingerprint travels with the command so an action fired against
          // a lens VS Code has not re-rendered yet is refused, not misapplied.
          arguments: [absPath, index, hunk.fingerprint],
        }),
        new vscode.CodeLens(range, {
          title: undo,
          command: "claudeKeepUndo.undoHunk",
          arguments: [absPath, index, hunk.fingerprint],
        })
      );
    });

    return lenses;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChange.dispose();
  }
}

/**
 * Is this file currently the modified side of an open Claude diff?
 *
 * CodeLens is provided per *document*, not per editor, so when a file is open
 * both in a diff tab and in an ordinary tab the same lenses necessarily render
 * in both. That is the one case `diffOnly` cannot separate — the API exposes no
 * editor to the provider — and it is the harmless direction: the rows appear
 * while a diff of that very file is open, and go away when it is closed.
 */
function isOpenInClaudeDiff(absPath: string): boolean {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputTextDiff) {
        if (
          input.original.scheme === BASELINE_SCHEME &&
          input.modified.fsPath === absPath
        ) {
          return true;
        }
        continue;
      }
      // The Multi Diff Editor opened by *Review All Claude Changes*.
      // `TabInputTextMultiDiff` is not in the 1.90 typings we compile against,
      // so it is recognised structurally.
      const multi = input as
        | { textDiffs?: { original?: vscode.Uri; modified?: vscode.Uri }[] }
        | undefined;
      if (
        Array.isArray(multi?.textDiffs) &&
        multi.textDiffs.some(
          (d) =>
            d.original?.scheme === BASELINE_SCHEME &&
            d.modified?.fsPath === absPath
        )
      ) {
        return true;
      }
    }
  }
  return false;
}
