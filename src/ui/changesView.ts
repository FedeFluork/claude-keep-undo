import * as path from "path";
import * as vscode from "vscode";
import { ReviewStore } from "../changeStore";
import { Hunk } from "../diff";
import { viewBadge } from "../settings";
import { isInsideRoot, normalizePath, owningRoot } from "../util";
import {
  EOL_ONLY_EXPLANATION,
  EOL_ONLY_LABEL,
  WHOLE_FILE_EXPLANATION,
  WHOLE_FILE_LABEL,
  hunkDiffText,
  hunkPreview,
  pluralChanges,
  pluralFiles,
  summarizeHunk,
} from "./format";

export type ChangeNode =
  | { type: "folder"; root: string; name: string }
  | { type: "file"; path: string }
  | { type: "hunk"; path: string; index: number; fingerprint: string }
  | { type: "unreviewable"; path: string };

/** Files with few enough changes to be worth showing expanded straight away. */
const AUTO_EXPAND_LIMIT = 3;

/**
 * The "Claude: Changes to Review" view in the Explorer. Top level lists the
 * modified files; expanding a file lists its individual hunks. Both levels carry
 * inline Keep/Undo buttons.
 *
 * In a multi-root window the top level is the folders that have something to
 * review; expanding a folder lists its files. A single-root window stays flat.
 *
 * Files Claude changed but that could not be given an exact baseline are listed
 * too, in their own rows: omitting them silently would look like the extension
 * had missed the edit.
 */
export class ChangesViewProvider
  implements vscode.TreeDataProvider<ChangeNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    ChangeNode | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly listener: vscode.Disposable;

  constructor(private readonly store: ReviewStore) {
    this.listener = store.onDidChange(() =>
      this._onDidChangeTreeData.fire(undefined)
    );
  }

  getChildren(element?: ChangeNode): ChangeNode[] {
    if (!element) {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length > 1) {
        return folders
          .filter((folder) => this.nodesInFolder(folder.uri.fsPath).length > 0)
          .map((folder) => ({
            type: "folder" as const,
            root: folder.uri.fsPath,
            name: folder.name,
          }));
      }
      return this.fileNodes();
    }
    if (element.type === "folder") {
      return this.nodesInFolder(element.root);
    }
    if (element.type === "file") {
      const hunks = this.store.get(element.path)?.hunks ?? [];
      return hunks.map((hunk, index) => ({
        type: "hunk" as const,
        path: element.path,
        index,
        fingerprint: hunk.fingerprint,
      }));
    }
    return [];
  }

  /** Lets callers reveal a hunk in the tree from the editor. */
  getParent(node: ChangeNode): ChangeNode | undefined {
    if (node.type === "hunk") {
      return { type: "file", path: node.path };
    }
    if (
      (node.type === "file" || node.type === "unreviewable") &&
      (vscode.workspace.workspaceFolders?.length ?? 0) > 1
    ) {
      return this.folderNodeFor(node.path);
    }
    return undefined;
  }

  getTreeItem(node: ChangeNode): vscode.TreeItem {
    if (node.type === "folder") {
      return this.folderItem(node);
    }
    if (node.type === "unreviewable") {
      return this.unreviewableItem(node);
    }
    if (node.type === "file") {
      return this.fileItem(node);
    }
    return this.hunkItem(node);
  }

  private fileNodes(): ChangeNode[] {
    return [
      ...this.store.getTracked().map((f) => ({
        type: "file" as const,
        path: f.path,
      })),
      ...this.store.getUnreviewable().map((u) => ({
        type: "unreviewable" as const,
        path: u.path,
      })),
    ];
  }

  private nodesInFolder(root: string): ChangeNode[] {
    return this.fileNodes().filter((node) => {
      if (node.type !== "file" && node.type !== "unreviewable") {
        return false;
      }
      return this.ownedBy(root, node.path);
    });
  }

  private ownedBy(root: string, absPath: string): boolean {
    if (!isInsideRoot(root, absPath)) {
      return false;
    }
    const roots = (vscode.workspace.workspaceFolders ?? []).map(
      (folder) => folder.uri.fsPath
    );
    const owner = owningRoot(roots, absPath);
    return owner !== undefined && normalizePath(owner) === normalizePath(root);
  }

  private folderNodeFor(absPath: string): ChangeNode | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const owner = owningRoot(
      folders.map((folder) => folder.uri.fsPath),
      absPath
    );
    const folder = folders.find(
      (f) =>
        owner !== undefined &&
        normalizePath(f.uri.fsPath) === normalizePath(owner)
    );
    return folder
      ? { type: "folder", root: folder.uri.fsPath, name: folder.name }
      : undefined;
  }

  private folderItem(node: ChangeNode & { type: "folder" }): vscode.TreeItem {
    const count = this.nodesInFolder(node.root).length;
    const item = new vscode.TreeItem(
      node.name,
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.id = `folder:${node.root}`;
    item.contextValue = "claudeFolder";
    item.iconPath = vscode.ThemeIcon.Folder;
    item.description = String(count);
    item.tooltip = node.root;
    return item;
  }

  private fileItem(node: ChangeNode & { type: "file" }): vscode.TreeItem {
    const tracked = this.store.get(node.path);
    const count = tracked?.hunks.length ?? 0;
    const item = new vscode.TreeItem(
      vscode.Uri.file(node.path),
      count > 0 && count <= AUTO_EXPAND_LIMIT
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );
    // A stable id keeps the expansion state across the frequent refreshes.
    item.id = node.path;
    item.contextValue = "claudeChange";

    const notes: string[] = [];
    if (tracked?.missing) {
      notes.push("deleted");
    }
    if (tracked?.userTouched) {
      notes.push("edited by you");
    }
    if (tracked?.degraded) {
      notes.push(WHOLE_FILE_LABEL);
    }
    if (tracked?.hunks.some((h) => h.eolOnly)) {
      notes.push(EOL_ONLY_LABEL);
    }
    const dir = relativeDir(node.path);
    item.description = [dir, ...notes].filter(Boolean).join(" • ");

    const lines = [`${pluralChanges(count)} to review`];
    if (tracked?.missing) {
      lines.push(
        "This file no longer exists. Keep forgets it; Undo restores it."
      );
    }
    if (tracked?.userTouched) {
      lines.push(
        "You have edited this file too — Undo would discard your changes as well."
      );
    }
    if (tracked?.degraded) {
      lines.push(WHOLE_FILE_EXPLANATION);
    }
    if (tracked?.hunks.some((h) => h.eolOnly)) {
      lines.push(EOL_ONLY_EXPLANATION);
    }
    item.tooltip = lines.join("\n");

    item.command = {
      command: "claudeKeepUndo.openDiff",
      title: "Open Diff",
      arguments: [node.path],
    };
    return item;
  }

  /**
   * Content first, coordinates second.
   *
   * Leading with `L12 +3 −1` means scanning ten rows is reading ten line
   * numbers to find the one that matters. The Search and Problems views put the
   * matched text in the label and the position beside it, which is exactly why
   * they are scannable.
   */
  private hunkItem(node: ChangeNode & { type: "hunk" }): vscode.TreeItem {
    const hunk = this.store.get(node.path)?.hunks[node.index];
    const item = new vscode.TreeItem(
      hunk ? hunkLabel(hunk, node.index) : `change ${node.index + 1}`,
      vscode.TreeItemCollapsibleState.None
    );
    item.id = `${node.path}#${node.index}`;
    item.iconPath = new vscode.ThemeIcon("git-compare");
    item.contextValue = "claudeHunk";
    item.description = hunk ? hunkCoordinates(hunk) : undefined;
    item.tooltip = hunk ? hunkTooltip(hunk) : undefined;
    item.command = {
      command: "claudeKeepUndo.openDiff",
      title: "Go to Change",
      arguments: [node.path, hunk ? hunk.currentStart : 0],
    };
    return item;
  }

  /**
   * A file Claude changed that has no exact baseline.
   *
   * Clicking the row opens the file, because everywhere else in VS Code
   * clicking a tree row navigates. Installing the hooks — which writes to
   * `.claude/settings.local.json` — is an explicit button on the row instead.
   */
  private unreviewableItem(
    node: ChangeNode & { type: "unreviewable" }
  ): vscode.TreeItem {
    const reason =
      this.store.getUnreviewable().find((u) => u.path === node.path)?.reason ??
      "no exact baseline could be established";
    const item = new vscode.TreeItem(
      vscode.Uri.file(node.path),
      vscode.TreeItemCollapsibleState.None
    );
    item.id = `unreviewable:${node.path}`;
    item.contextValue = "claudeUnreviewable";
    item.description = "not reviewable";
    item.tooltip = new vscode.MarkdownString(
      `Claude changed this file, but ${reason}.\n\n` +
        "Showing it against a guessed original would be worse than not showing " +
        "it at all. **Install the Claude Code hooks** for exact baselines."
    );
    item.command = {
      command: "vscode.open",
      title: "Open File",
      arguments: [vscode.Uri.file(node.path)],
    };
    return item;
  }

  dispose(): void {
    this.listener.dispose();
    this._onDidChangeTreeData.dispose();
  }
}

/**
 * Owns the TreeView itself so the count can be published on its header badge.
 *
 * The Source Control entry has always had one; the Explorer view — the primary
 * surface, and the one the README points at — did not, so a collapsed section
 * hid the whole queue.
 */
export class ChangesView implements vscode.Disposable {
  private readonly view: vscode.TreeView<ChangeNode>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: ReviewStore,
    provider: ChangesViewProvider
  ) {
    this.view = vscode.window.createTreeView("claudeKeepUndo.changes", {
      treeDataProvider: provider,
      showCollapseAll: true,
    });
    this.disposables.push(
      this.view,
      store.onDidChange(() => this.refreshBadge()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("claudeKeepUndo.viewBadge")) {
          this.refreshBadge();
        }
      })
    );
    this.refreshBadge();
  }

  private refreshBadge(): void {
    const count = this.store.count();
    this.view.badge =
      viewBadge() && count > 0
        ? { value: count, tooltip: `${pluralFiles(count)} to review` }
        : undefined;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function relativeDir(absPath: string): string {
  const rel = vscode.workspace.asRelativePath(path.dirname(absPath), false);
  return rel === "." ? "" : rel;
}

function hunkLabel(hunk: Hunk, index: number): string {
  return hunkPreview(hunk) || `change ${index + 1}`;
}

function hunkCoordinates(hunk: Hunk): string {
  const parts = [`L${hunk.currentStart + 1}`, summarizeHunk(hunk)];
  if (hunk.degraded) {
    parts.push(WHOLE_FILE_LABEL);
  }
  return parts.join(" · ");
}

function hunkTooltip(hunk: Hunk): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  if (hunk.eolOnly) {
    md.appendMarkdown(EOL_ONLY_EXPLANATION);
    return md;
  }
  md.appendCodeblock(hunkDiffText(hunk), "diff");
  if (hunk.degraded) {
    md.appendMarkdown(`\n\n${WHOLE_FILE_EXPLANATION}`);
  }
  return md;
}
