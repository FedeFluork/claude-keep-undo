import * as vscode from "vscode";
import { ChangeStore } from "../changeStore";
import { statusBarMode } from "../settings";
import { pluralChanges, pluralFiles } from "./format";

/**
 * The one ambient signal that survives having the Explorer closed.
 *
 * With the Search or Debug view open and no tracked file focused, nothing else
 * tells you that eleven files are waiting: the tree is hidden, and the Explorer
 * badge needs the file to be visible in it.
 */
export class ReviewStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly store: ChangeStore) {
    this.item = vscode.window.createStatusBarItem(
      "claudeKeepUndo.pending",
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.name = "Claude Keep/Undo";
    this.item.command = "claudeKeepUndo.openAllChanges";
    this.disposables.push(
      this.item,
      store.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("claudeKeepUndo.statusBar")) {
          this.refresh();
        }
      })
    );
    this.refresh();
  }

  private refresh(): void {
    const mode = statusBarMode();
    const files = this.store.count();
    if (mode === "off" || (mode === "whenPending" && files === 0)) {
      this.item.hide();
      return;
    }
    if (files === 0) {
      this.item.text = "$(git-compare) No Claude changes";
      this.item.tooltip = "Nothing from Claude Code is awaiting review.";
      this.item.command = undefined;
      this.item.show();
      return;
    }
    const changes = this.store
      .getTracked()
      .reduce((total, file) => total + file.hunks.length, 0);
    this.item.text = `$(git-compare) Claude: ${pluralFiles(files)}`;
    this.item.tooltip = `${pluralFiles(files)} awaiting review (${pluralChanges(
      changes
    )}) — click to open them all in one diff.`;
    this.item.command = "claudeKeepUndo.openAllChanges";
    this.item.show();
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
