import * as path from "path";
import * as vscode from "vscode";
import { ChangeStore } from "../changeStore";
import { sourceControlList, wantsGutterBars, write } from "../settings";
import { fileExists } from "../util";
import { pluralChanges } from "./format";
import { toBaselineUri } from "./diffView";

/**
 * Must match the `scmProvider == …` clauses in package.json.
 */
export const SOURCE_CONTROL_ID = "claudeKeepUndo";

/**
 * Registers a Source Control provider whose main job is to own a
 * {@link vscode.QuickDiffProvider}. That single stable API buys the review UX
 * that otherwise needs proposed API:
 *
 *  - coloured change bars in the gutter of the **real editor**, not a diff tab;
 *  - VS Code's built-in quick diff peek widget, which renders the original lines
 *    **inline inside the file** when a bar is clicked;
 *  - a toolbar in that widget, which we populate through the `scm/change/title`
 *    menu (gated on `originalResourceScheme == claude-baseline`, so our Keep and
 *    Undo appear on our changes and never on Git's).
 *
 * VS Code renders every *visible* quick diff provider, and only skips
 * non-primary providers whose changes overlap the primary one. A provider
 * attached to a SourceControl is primary, so ours coexists with Git's rather
 * than being suppressed by it.
 *
 * The resource group is a bonus, and a separate setting: it puts the pending
 * files in the Source Control view with the same Keep/Undo actions, via
 * `scm/resourceState/context`. When neither the bars nor the list are wanted,
 * the whole registration goes away rather than leaving an empty section behind.
 */
export class ClaudeSourceControl implements vscode.Disposable {
  private scm: vscode.SourceControl | undefined;
  private group: vscode.SourceControlResourceGroup | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly provider: vscode.QuickDiffProvider = {
    provideOriginalResource: (uri) =>
      uri.scheme === "file" && this.store.isTracked(uri.fsPath)
        ? toBaselineUri(uri.fsPath)
        : undefined,
  };

  constructor(
    private readonly workspaceFolder: vscode.WorkspaceFolder,
    private readonly store: ChangeStore
  ) {
    this.disposables.push(
      store.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("claudeKeepUndo.inlineReview") ||
          e.affectsConfiguration("claudeKeepUndo.sourceControlList")
        ) {
          this.apply();
        }
      })
    );
    this.apply();
  }

  private ensureRegistered(): void {
    if (this.scm) {
      return;
    }
    this.scm = vscode.scm.createSourceControl(
      SOURCE_CONTROL_ID,
      "Claude Changes",
      this.workspaceFolder.uri
    );
    // We are not a real SCM: no commit message, no accept action.
    this.scm.inputBox.visible = false;
    this.group = this.scm.createResourceGroup("pending", "Awaiting review");
    this.group.hideWhenEmpty = true;
  }

  private teardown(): void {
    this.group?.dispose();
    this.scm?.dispose();
    this.group = undefined;
    this.scm = undefined;
  }

  private apply(): void {
    const bars = wantsGutterBars();
    const list = sourceControlList();
    if (!bars && !list) {
      this.teardown();
      return;
    }
    this.ensureRegistered();
    this.scm!.quickDiffProvider = bars ? this.provider : undefined;
    this.refresh();
  }

  private refresh(): void {
    if (!this.scm || !this.group) {
      return;
    }
    if (!sourceControlList()) {
      this.group.resourceStates = [];
      this.scm.count = 0;
      return;
    }
    const tracked = this.store.getTracked();
    this.group.resourceStates = tracked.map((file) => ({
      resourceUri: vscode.Uri.file(file.path),
      contextValue: "claudeScmChange",
      command: {
        command: "claudeKeepUndo.openDiff",
        title: "Open Diff",
        arguments: [file.path],
      },
      decorations: {
        tooltip: `${pluralChanges(file.hunks.length)} to review`,
      },
    }));
    this.scm.count = tracked.length;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.teardown();
  }
}

/**
 * In a Git repository two providers draw change bars on the same lines: Git
 * compares against HEAD, we compare against the pre-Claude baseline, and for a
 * fresh edit those are the same lines. VS Code renders both because a provider
 * attached to a SourceControl is "primary" and is never suppressed on overlap.
 *
 * That is what makes the feature work at all, but it surprises people — so it is
 * said once, and only at the moment there is something on screen to point at.
 * Said at activation instead, it is an unprompted advertisement for a widget
 * that does not exist yet, and it burns its one chance to be useful.
 */
export class DoubledGutterNotice implements vscode.Disposable {
  private static readonly KEY = "explainedDoubledGutter";
  private readonly disposables: vscode.Disposable[] = [];
  private showing = false;

  constructor(
    private readonly workspaceRoot: string,
    private readonly store: ChangeStore,
    private readonly memento: vscode.Memento
  ) {
    if (this.done()) {
      return;
    }
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => void this.maybeShow()),
      store.onDidChange(() => void this.maybeShow())
    );
    void this.maybeShow();
  }

  private done(): boolean {
    return this.memento.get<boolean>(DoubledGutterNotice.KEY) === true;
  }

  /** A file with bars on it is actually on screen right now. */
  private trackedFileVisible(): boolean {
    return vscode.window.visibleTextEditors.some(
      (e) =>
        e.document.uri.scheme === "file" &&
        this.store.isTracked(e.document.uri.fsPath)
    );
  }

  private async maybeShow(): Promise<void> {
    if (this.showing || this.done()) {
      return;
    }
    if (!wantsGutterBars() || !this.trackedFileVisible()) {
      return;
    }
    if (!fileExists(path.join(this.workspaceRoot, ".git"))) {
      return;
    }

    this.showing = true;
    try {
      const choice = await vscode.window.showInformationMessage(
        "Keep / Undo for Claude Code marks Claude's changes in the editor gutter. In a Git repository you will see its bars alongside Git's own — click one to open the Quick Diff widget, where Keep and Undo live.",
        "Got it",
        "Use inline comments instead"
      );
      // Marked only once the message has actually been seen and answered. Doing
      // it first means a restart, or a burst of other toasts, spends the one
      // explanation on nobody.
      await this.memento.update(DoubledGutterNotice.KEY, true);
      if (choice === "Use inline comments instead") {
        await write(
          "inlineReview",
          "comments",
          vscode.ConfigurationTarget.Workspace
        );
      }
      this.dispose();
    } finally {
      this.showing = false;
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
