import * as vscode from "vscode";
import { ChangeStore } from "../changeStore";
import { Hunk, hunkLineRange } from "../diff";
import { wantsCommentThreads } from "../settings";
import { hunkDiffText, summarizeHunk } from "./format";

/** Must match the `commentController == …` clauses in package.json. */
export const COMMENT_CONTROLLER_ID = "claudeKeepUndo";

/**
 * Renders each pending hunk as a comment thread anchored to its lines.
 *
 * The Comments API is the one stable way to place a real widget *between* editor
 * lines: the thread body shows the removed and added lines as a unified diff —
 * the "phantom deleted lines" effect — and Keep/Undo live in the thread's
 * toolbar via the `comments/commentThread/title` menu.
 *
 * It is opt-in (`claudeKeepUndo.inlineReview`) because the chrome is heavier
 * than the quick diff gutter. It is also the fallback when the gutter is
 * crowded by another SCM provider.
 *
 * Threads are only created for files the user has open in a visible editor, so
 * a large review queue does not flood the Comments panel, and are only rebuilt
 * when a file's hunks actually change so they do not flicker while typing.
 */
export class CommentReviewController implements vscode.Disposable {
  private controller: vscode.CommentController | undefined;
  private readonly threads = new Map<string, vscode.CommentThread[]>();
  private readonly signatures = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly store: ChangeStore) {
    this.disposables.push(
      store.onDidChange(() => this.schedule()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("claudeKeepUndo.inlineReview")) {
          this.schedule();
        }
      })
    );
    this.schedule();
  }

  private enabled(): boolean {
    return wantsCommentThreads();
  }

  private schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.sync();
    }, 150);
  }

  private sync(): void {
    if (this.disposed) {
      return;
    }
    if (!this.enabled()) {
      this.clearThreads();
      this.controller?.dispose();
      this.controller = undefined;
      return;
    }
    if (!this.controller) {
      this.controller = vscode.comments.createCommentController(
        COMMENT_CONTROLLER_ID,
        "Claude Changes"
      );
    }

    const visible = new Set(
      vscode.window.visibleTextEditors
        .filter((e) => e.document.uri.scheme === "file")
        .map((e) => e.document.uri.fsPath)
    );

    for (const fsPath of [...this.threads.keys()]) {
      if (!visible.has(fsPath) || !this.store.isTracked(fsPath)) {
        this.dropThreads(fsPath);
      }
    }
    for (const fsPath of visible) {
      this.rebuild(fsPath);
    }
  }

  /** Rebuild a file's threads, but only when its hunks actually changed. */
  private rebuild(fsPath: string): void {
    const tracked = this.store.get(fsPath);
    if (!tracked || !this.controller) {
      this.dropThreads(fsPath);
      return;
    }
    // The fingerprint digests the hunk's *content* as well as its position. A
    // signature built from positions and lengths alone cannot tell `= 30` from
    // `= 60` from `= 90`, so the thread went on rendering the first version's
    // diff body while Keep/Undo acted on the live one.
    const signature = tracked.hunks.map((h) => h.fingerprint).join("|");
    if (this.signatures.get(fsPath) === signature) {
      return;
    }

    const uri = vscode.Uri.file(fsPath);
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.scheme === "file" && d.uri.fsPath === fsPath
    );
    const lastLine = doc
      ? Math.max(0, doc.lineCount - 1)
      : Number.MAX_SAFE_INTEGER;

    // Reuse the existing widgets when the hunk count is unchanged. Disposing and
    // recreating them made every thread collapse and lose its scroll anchor each
    // time Claude landed another edit in the same file.
    const existing = this.threads.get(fsPath);
    if (existing && existing.length === tracked.hunks.length) {
      tracked.hunks.forEach((hunk, i) => {
        const thread = existing[i];
        thread.range = rangeFor(hunk, lastLine);
        thread.label = threadLabel(hunk);
        thread.comments = [commentFor(hunk)];
      });
      this.signatures.set(fsPath, signature);
      return;
    }

    this.dropThreads(fsPath);
    const created = tracked.hunks.map((hunk) =>
      this.createThread(uri, hunk, lastLine)
    );
    if (created.length > 0) {
      this.threads.set(fsPath, created);
      this.signatures.set(fsPath, signature);
    }
  }

  private createThread(
    uri: vscode.Uri,
    hunk: Hunk,
    lastLine: number
  ): vscode.CommentThread {
    const thread = this.controller!.createCommentThread(
      uri,
      rangeFor(hunk, lastLine),
      [commentFor(hunk)]
    );
    thread.label = threadLabel(hunk);
    // Read by the `commentThread == claudeHunk` clause in package.json.
    thread.contextValue = "claudeHunk";
    thread.canReply = false;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    return thread;
  }

  private dropThreads(fsPath: string): void {
    for (const thread of this.threads.get(fsPath) ?? []) {
      thread.dispose();
    }
    this.threads.delete(fsPath);
    this.signatures.delete(fsPath);
  }

  private clearThreads(): void {
    for (const fsPath of [...this.threads.keys()]) {
      this.dropThreads(fsPath);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.clearThreads();
    this.controller?.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function rangeFor(hunk: Hunk, lastLine: number): vscode.Range {
  const { start, end } = hunkLineRange(hunk);
  return new vscode.Range(
    Math.min(start, lastLine),
    0,
    Math.min(end, lastLine),
    0
  );
}

function threadLabel(hunk: Hunk): string {
  return `Claude change (${summarizeHunk(hunk)})`;
}

function commentFor(hunk: Hunk): vscode.Comment {
  const body = new vscode.MarkdownString();
  body.appendCodeblock(hunkDiffText(hunk), "diff");
  return {
    body,
    mode: vscode.CommentMode.Preview,
    author: { name: "Claude Code" },
    contextValue: "claudeHunk",
  };
}
