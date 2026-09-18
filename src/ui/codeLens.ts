import * as vscode from "vscode";
import { ReviewStore } from "../changeStore";
import { codeLensMode, codeLensStyle } from "../settings";
import { BASELINE_SCHEME } from "../util";
import { WHOLE_FILE_LABEL, pluralChanges, summarizeHunk } from "./format";
import { currentHunkIndex, neighborHunkIndex } from "./hunkNav";

/**
 * Per-hunk "Keep | Undo" actions rendered inline above each change (plus a file
 * summary with Keep all / Undo all). When a file has several hunks, the hunk
 * under the caret also gets prev / n of N / next on the same inserted row.
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

  constructor(private readonly store: ReviewStore) {
    this.disposables.push(
      store.onDidChange(() => this._onDidChange.fire()),
      // In `diffOnly` mode the answer depends on which tabs are open, so the
      // lenses have to be recomputed when that changes — otherwise opening the
      // diff of a file that is already visible would show none.
      vscode.window.tabGroups.onDidChangeTabs(() => this._onDidChange.fire()),
      vscode.window.onDidChangeActiveTextEditor(() => this._onDidChange.fire()),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        const key = this.navKey(e.textEditor);
        if (key !== this.lastNavKey) {
          this.lastNavKey = key;
          this._onDidChange.fire();
        }
      }),
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

  private lastNavKey = "";

  /** Cheap identity for "did the current-hunk extras move?" */
  private navKey(editor: vscode.TextEditor): string {
    if (editor.document.uri.scheme !== "file") {
      return "";
    }
    const absPath = editor.document.uri.fsPath;
    const tracked = this.store.get(absPath);
    if (!tracked || tracked.hunks.length < 2) {
      return absPath;
    }
    return `${absPath}:${currentHunkIndex(tracked.hunks, editor.selection.active.line)}`;
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
    // A codicon is themed; an emoji is not. `codeLensStyle: emoji` asks for the
    // louder rendering and accepts that cost — the default should not pay it.
    const prev = codeLensStyle() === "emoji" ? "⬆️ prev" : "$(arrow-up) prev";
    const next = codeLensStyle() === "emoji" ? "⬇️ next" : "$(arrow-down) next";
    const currentIndex =
      tracked.hunks.length > 1 ? this.currentHunkFor(document) : undefined;

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
      if (index === currentIndex) {
        const total = tracked.hunks.length;
        const back = neighborHunkIndex(tracked.hunks, index, -1);
        const forward = neighborHunkIndex(tracked.hunks, index, 1);
        lenses.push(
          new vscode.CodeLens(range, {
            title: `${prev}${GAP}`,
            command: "claudeKeepUndo.gotoHunk",
            // The fingerprint travels with the command here for the same reason
            // it does with Keep and Undo: the target index was resolved when
            // this lens was built, and by the time it is clicked the hunk list
            // may have moved underneath it.
            arguments: [absPath, back, tracked.hunks[back].fingerprint],
          }),
          new vscode.CodeLens(range, {
            title: `${GAP}${index + 1} of ${total}${GAP}`,
            tooltip: `Claude change ${index + 1} of ${total}`,
            // Empty command: VS Code still shows the title, but as plain text
            // rather than a link. Jumping here would be a no-op — these extras
            // only render on the hunk the caret is already in.
            command: "",
          }),
          new vscode.CodeLens(range, {
            title: `${GAP}${next}`,
            command: "claudeKeepUndo.gotoHunk",
            arguments: [absPath, forward, tracked.hunks[forward].fingerprint],
          })
        );
      }
    });

    return lenses;
  }

  /**
   * Hunk under the caret in the active editor for this document. Undefined when
   * this file is not focused — extras would otherwise pin to a stale hunk.
   */
  private currentHunkFor(document: vscode.TextDocument): number | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== document.uri.toString()) {
      return undefined;
    }
    const tracked = this.store.get(document.uri.fsPath);
    if (!tracked || tracked.hunks.length === 0) {
      return undefined;
    }
    return currentHunkIndex(tracked.hunks, editor.selection.active.line);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChange.dispose();
  }
}

/**
 * Padding for the two pipes *inside* the navigation group.
 *
 * VS Code draws `\u00a0|\u00a0` between items and runs `title.trim()`, so a real
 * space is stripped before it ever renders. A U+2800 braille blank is not
 * whitespace to `trim()`, so it survives, and three short items in a row read
 * better with it.
 *
 * Deliberately only on the inner edges. The boundary with `Undo` keeps the
 * stock spacing, and Keep / Undo / Keep all / Undo all stay plain ASCII:
 * U+2800 has no glyph in a font without Braille coverage, and the review
 * actions themselves are not worth that risk.
 */
const GAP = "\u2800";

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
