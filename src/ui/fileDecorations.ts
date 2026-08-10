import * as vscode from "vscode";
import { ChangeStore } from "../changeStore";
import { badgeGlyph, explorerBadgeMode } from "../settings";
import { pluralChanges } from "./format";

/**
 * Adds a badge + colored label in the Explorer for files Claude has modified
 * and that are awaiting review — the equivalent of Copilot's marker.
 *
 * Propagation to parent folders is a setting rather than a given: it helps find
 * a change in a collapsed tree, but it walks all the way to the workspace root,
 * so with any change anywhere the root folder ends up permanently marked — and a
 * mark that is always on carries no information.
 */
export class ClaudeFileDecorationProvider
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private readonly _onDidChange = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly store: ChangeStore) {
    this.disposables.push(
      store.onDidChange((uri) => this._onDidChange.fire(uri ?? undefined)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("claudeKeepUndo.explorerBadge") ||
          e.affectsConfiguration("claudeKeepUndo.badge")
        ) {
          this._onDidChange.fire(undefined);
        }
      })
    );
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const mode = explorerBadgeMode();
    if (mode === "off" || uri.scheme !== "file") {
      return undefined;
    }
    if (!this.store.isTracked(uri.fsPath)) {
      return undefined;
    }
    const tracked = this.store.get(uri.fsPath);
    const count = tracked?.hunks.length ?? 0;

    const notes = [`Claude: ${pluralChanges(count)} to review`];
    if (tracked?.userTouched) {
      notes.push(
        "You have edited this file too — Undo discards your changes as well."
      );
    }
    const decoration = new vscode.FileDecoration(
      badgeGlyph(),
      notes.join("\n"),
      new vscode.ThemeColor("claudeKeepUndo.modifiedResourceForeground")
    );
    decoration.propagate = mode === "fileAndFolders";
    return decoration;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChange.dispose();
  }
}
