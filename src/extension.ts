import * as path from "path";
import * as vscode from "vscode";
import { ApplyResult, ChangeStore, UndoSnapshot } from "./changeStore";
import { ensureDir, listDir, pathKey } from "./util";
import { LineChange } from "./diff";
import {
  hooksState,
  installHooksInteractive,
  maybePromptInstall,
  repairHooksIfStale,
} from "./detection/hookInstaller";
import { HookState } from "./detection/hookSettings";
import { KeepUndoWatcher } from "./detection/keepUndoWatcher";
import { TranscriptWatcher } from "./detection/transcriptWatcher";
import * as settings from "./settings";
import { ChangeNode, ChangesView, ChangesViewProvider } from "./ui/changesView";
import { ClaudeCodeActionProvider } from "./ui/codeActions";
import { ClaudeCodeLensProvider } from "./ui/codeLens";
import { CommentReviewController } from "./ui/commentReview";
import {
  BASELINE_SCHEME,
  BaselineContentProvider,
  openClaudeDiff,
  toBaselineUri,
} from "./ui/diffView";
import { DiffLayoutController } from "./ui/diffLayout";
import { Feedback, shortName } from "./ui/feedback";
import { ClaudeFileDecorationProvider } from "./ui/fileDecorations";
import { pluralChanges, pluralFiles } from "./ui/format";
import { goToChange } from "./ui/navigation";
import { ClaudeSourceControl, DoubledGutterNotice } from "./ui/quickDiff";
import { PanelStatus, SettingsPanel } from "./ui/settingsPanel";
import { ReviewStatusBar } from "./ui/statusBar";

const ACTIVE_TRACKED_KEY = "claudeKeepUndo.activeDiffTracked";
const HAS_CHANGES_KEY = "claudeKeepUndo.hasChanges";
const HOOKS_INSTALLED_KEY = "claudeKeepUndo.hooksInstalled";
const EXPLORER_MENU_KEY = "claudeKeepUndo.explorerMenu";

/** Kept module-level so `deactivate()` can await the settings restore. */
let layoutController: DiffLayoutController | undefined;

/**
 * What `vscode.extensions.getExtension(...).exports` yields. Small on purpose:
 * it exists so the integration tests can find the state directory, which now
 * lives in VS Code's per-workspace storage rather than at a path they could
 * derive themselves.
 */
export interface KeepUndoApi {
  readonly stateDir: string;
  /**
   * The review store itself.
   *
   * Exposed for the integration tests: the destructive commands are wrapped in
   * modal confirmations that a test host cannot answer, so the behaviour behind
   * them — above all "Undo deletes a file Claude created" — is only reachable
   * this way. Nothing in the extension consumes it.
   */
  readonly store: ChangeStore;
}

export function activate(
  context: vscode.ExtensionContext
): KeepUndoApi | undefined {
  const output = vscode.window.createOutputChannel("Claude Keep/Undo");
  context.subscriptions.push(output);
  const log = (msg: string) => output.appendLine(`[${ts()}] ${msg}`);

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    log("No workspace folder open: extension inactive.");
    return undefined;
  }
  const workspaceRoot = folder.uri.fsPath;
  log(`Active on ${workspaceRoot}`);

  const stateDir = resolveStateDir(context, workspaceRoot);
  ensureDir(stateDir);
  log(`Review state: ${stateDir}`);
  const store = new ChangeStore(stateDir, workspaceRoot, log);
  context.subscriptions.push(store);

  // --- providers -----------------------------------------------------------
  const baselineProvider = new BaselineContentProvider(store);
  context.subscriptions.push(
    baselineProvider,
    vscode.workspace.registerTextDocumentContentProvider(
      BASELINE_SCHEME,
      baselineProvider
    )
  );

  const decorations = new ClaudeFileDecorationProvider(store);
  context.subscriptions.push(
    decorations,
    vscode.window.registerFileDecorationProvider(decorations)
  );

  const codeLens = new ClaudeCodeLensProvider(store);
  context.subscriptions.push(
    codeLens,
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, codeLens)
  );

  // Quick Fix path: Keep/Undo on the hunk under the cursor, keyboard-reachable.
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new ClaudeCodeActionProvider(store),
      ClaudeCodeActionProvider.metadata
    )
  );

  // Gutter change bars in the real editor + the built-in quick diff peek widget
  // (whose toolbar we fill through the `scm/change/title` menu), plus an
  // optional Source Control entry listing the files awaiting review.
  context.subscriptions.push(
    new ClaudeSourceControl(folder, store),
    new DoubledGutterNotice(workspaceRoot, store, context.workspaceState)
  );

  // Optional inline comment threads: removed/added lines rendered *between* the
  // editor lines, with Keep/Undo in the thread toolbar.
  context.subscriptions.push(new CommentReviewController(store));

  // Show the Claude diff as a single-pane (inline) diff instead of a split.
  const diffLayout = new DiffLayoutController(context);
  layoutController = diffLayout;
  context.subscriptions.push(diffLayout);

  const changesView = new ChangesViewProvider(store);
  context.subscriptions.push(changesView, new ChangesView(store, changesView));
  context.subscriptions.push(new ReviewStatusBar(store));

  const feedback = new Feedback(store);
  context.subscriptions.push(feedback);

  const openDiff = (absPath: string, atLine?: number) =>
    openClaudeDiff(absPath, {
      atLine,
      onOpening: () => diffLayout.notifyOpening(),
      siblings: store.getTracked().map((f) => f.path),
    });

  // --- commands ------------------------------------------------------------
  const report = (result: ApplyResult, action: string) => {
    if (result === "stale") {
      void vscode.window.showInformationMessage(
        `That change moved before ${action} could be applied. The list has been refreshed — try again.`
      );
    } else if (result === "failed") {
      void vscode.window.showErrorMessage(
        `${action} could not be written to disk. See the Claude Keep/Undo output channel.`
      );
    } else if (result === "applied-modified") {
      // The write landed; a save participant then reformatted it. Calling that a
      // failure told the user nothing had happened *after* their content was
      // already replaced, and suppressed the Restore button that was the way back.
      void vscode.window.showWarningMessage(
        `${action} was written, but a save participant reformatted the file, so it is still under review. Use Restore to put it back.`
      );
    } else if (result === "unavailable") {
      // Silence here is indistinguishable from a broken button.
      void vscode.window.showInformationMessage(
        `Nothing left to ${action.toLowerCase()}: this file has no pending Claude changes.`
      );
    }
    return result === "applied" || result === "applied-modified";
  };

  /** Apply a Keep and confirm it where the user can see it. */
  const keep = (result: ApplyResult, what: string) => {
    if (report(result, "Keep")) {
      feedback.kept(`Kept ${what}`);
    }
  };

  /**
   * Apply an Undo, capturing what it overwrites *first* so the notification can
   * offer to put it back.
   */
  const undo = async (
    paths: string[],
    what: string,
    run: () => Promise<ApplyResult>
  ) => {
    const snapshots = paths
      .map((p) => store.captureUndoSnapshot(p))
      .filter((s): s is UndoSnapshot => s !== undefined);
    if (report(await run(), "Undo")) {
      // Stamped after the undo landed: the record now knows what it left behind,
      // so a Restore fired much later can tell the file has moved on since.
      feedback.undone(`Undid ${what}`, store.stampPostUndo(snapshots));
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeKeepUndo.openDiff",
      async (arg?: unknown, line?: unknown) => {
        const p = resolvePath(arg);
        if (!p) {
          return;
        }
        if (!store.isTracked(p)) {
          void vscode.window.showInformationMessage(
            "No Claude changes to review for this file."
          );
          return;
        }
        await openDiff(p, typeof line === "number" ? line : undefined);
      }
    ),
    vscode.commands.registerCommand("claudeKeepUndo.openAllChanges", () =>
      openAllChanges(store)
    ),
    vscode.commands.registerCommand(
      "claudeKeepUndo.keepHunk",
      (arg?: unknown, idx?: unknown, fingerprint?: unknown) => {
        const h = resolveHunk(store, arg, idx, fingerprint);
        if (!h) {
          report("stale", "Keep");
          return;
        }
        keep(
          store.keepHunk(h.path, h.index, h.fingerprint),
          `${pluralChanges(1)} in ${shortName(h.path)}`
        );
      }
    ),
    vscode.commands.registerCommand(
      "claudeKeepUndo.undoHunk",
      async (arg?: unknown, idx?: unknown, fingerprint?: unknown) => {
        const h = resolveHunk(store, arg, idx, fingerprint);
        if (!h) {
          report("stale", "Undo");
          return;
        }
        // On a file Claude created the baseline is empty, so undoing its only
        // hunk removes the file. That deserves the same confirmation the
        // file-level Undo gives it.
        if (!(await confirmDestructive(store, [h.path], "change"))) {
          return;
        }
        await undo(
          [h.path],
          `${pluralChanges(1)} in ${shortName(h.path)}`,
          () => store.undoHunk(h.path, h.index, h.fingerprint)
        );
      }
    ),
    // Invoked from the quick diff peek widget (`scm/change/title`) with
    // (uri, changes, index). Resolving the change from its own line coordinates
    // keeps the action bound to what the user is looking at.
    vscode.commands.registerCommand(
      "claudeKeepUndo.keepChange",
      (uri?: unknown, changes?: unknown, index?: unknown) => {
        const c = resolveLineChange(uri, changes, index);
        if (!c) {
          report("stale", "Keep");
          return;
        }
        keep(
          store.keepLineChange(c.path, c.change),
          `${pluralChanges(1)} in ${shortName(c.path)}`
        );
      }
    ),
    vscode.commands.registerCommand(
      "claudeKeepUndo.undoChange",
      async (uri?: unknown, changes?: unknown, index?: unknown) => {
        const c = resolveLineChange(uri, changes, index);
        if (!c) {
          report("stale", "Undo");
          return;
        }
        if (!(await confirmDestructive(store, [c.path], "change"))) {
          return;
        }
        await undo(
          [c.path],
          `${pluralChanges(1)} in ${shortName(c.path)}`,
          () => store.undoLineChange(c.path, c.change)
        );
      }
    ),
    // Invoked from the line-number context menu with { lineNumber, uri }.
    vscode.commands.registerCommand(
      "claudeKeepUndo.keepAtLine",
      (arg?: unknown) => keepResolved(resolveLineArg(store, arg))
    ),
    vscode.commands.registerCommand(
      "claudeKeepUndo.undoAtLine",
      (arg?: unknown) => undoResolved(resolveLineArg(store, arg))
    ),
    // The keyboard path: same two actions, resolved from the caret.
    vscode.commands.registerCommand("claudeKeepUndo.keepAtCursor", () =>
      keepResolved(resolveCursor(store))
    ),
    vscode.commands.registerCommand("claudeKeepUndo.undoAtCursor", () =>
      undoResolved(resolveCursor(store))
    ),
    vscode.commands.registerCommand("claudeKeepUndo.nextChange", () =>
      goToChange(store, 1)
    ),
    vscode.commands.registerCommand("claudeKeepUndo.previousChange", () =>
      goToChange(store, -1)
    ),
    vscode.commands.registerCommand(
      "claudeKeepUndo.keepFile",
      (arg?: unknown) => {
        const p = resolvePath(arg);
        if (!p) {
          return;
        }
        if (!store.isTracked(p)) {
          report("unavailable", "Keep");
          return;
        }
        const count = store.get(p)?.hunks.length ?? 0;
        store.keepFile(p);
        feedback.kept(`Kept ${pluralChanges(count)} in ${shortName(p)}`);
      }
    ),
    vscode.commands.registerCommand(
      "claudeKeepUndo.undoFile",
      async (arg?: unknown) => {
        const p = resolvePath(arg);
        if (!p) {
          return;
        }
        if (!store.isTracked(p)) {
          report("unavailable", "Undo");
          return;
        }
        if (!(await confirmDestructive(store, [p], "file"))) {
          return;
        }
        const count = store.get(p)?.hunks.length ?? 0;
        await undo([p], `${pluralChanges(count)} in ${shortName(p)}`, () =>
          store.undoFile(p)
        );
      }
    ),
    vscode.commands.registerCommand("claudeKeepUndo.keepAll", () => {
      const n = store.count();
      store.keepAll();
      if (n > 0) {
        feedback.kept(`Kept Claude's changes in ${pluralFiles(n)}`);
      }
    }),
    vscode.commands.registerCommand("claudeKeepUndo.undoAll", async () => {
      if (store.count() === 0) {
        return;
      }
      const paths = store.getTracked().map((f) => f.path);
      if (!(await confirmDestructive(store, paths, "all"))) {
        return;
      }
      const snapshots = paths
        .map((p) => store.captureUndoSnapshot(p))
        .filter((s): s is UndoSnapshot => s !== undefined);
      // Exactly the set that was named in the confirmation and snapshotted.
      // Re-reading the live tracked map here reverted files the user never
      // confirmed — the watchers keep registering baselines while a modal is up —
      // and deleted files Claude created with no deletion warning at all.
      const { applied, reformatted, failed, deleted } =
        await store.undoPaths(paths);
      const done = applied + reformatted.length;
      if (done > 0) {
        // Armed before any failure is reported: the snapshots are valid for every
        // path that really was overwritten, and one file the formatter touched used
        // to cost the whole batch its Restore point.
        const detail =
          deleted.length > 0
            ? `, deleting ${pluralFiles(deleted.length)} Claude created`
            : "";
        feedback.undone(
          `Undid Claude's changes in ${pluralFiles(done)}${detail}`,
          store.stampPostUndo(snapshots.filter((s) => !failed.includes(s.path)))
        );
      }
      if (reformatted.length > 0) {
        void vscode.window.showWarningMessage(
          `${pluralFiles(reformatted.length)} ${
            reformatted.length === 1 ? "was" : "were"
          } restored but reformatted on save, so ${
            reformatted.length === 1 ? "it is" : "they are"
          } still under review.`
        );
      }
      if (failed.length > 0) {
        void vscode.window.showErrorMessage(
          `${failed.length} of ${done + failed.length} files could not be restored. See the Claude Keep/Undo output channel.`
        );
      }
    }),
    vscode.commands.registerCommand("claudeKeepUndo.restoreLastUndo", () =>
      feedback.restore()
    ),
    vscode.commands.registerCommand("claudeKeepUndo.installHooks", () => {
      installHooksInteractive(workspaceRoot, context.extensionPath, stateDir);
      refreshHookContext();
    }),
    vscode.commands.registerCommand("claudeKeepUndo.openSettings", () =>
      SettingsPanel.show(context, panelStatus, statusChanged.event)
    ),
    vscode.commands.registerCommand("claudeKeepUndo.openWalkthrough", () =>
      vscode.commands.executeCommand(
        "workbench.action.openWalkthrough",
        "FedeFluork.claude-keep-undo#setup",
        false
      )
    ),
    vscode.commands.registerCommand("claudeKeepUndo.refresh", () => {
      store.refreshFromDisk();
      refreshHookContext();
    }),
    vscode.commands.registerCommand("claudeKeepUndo.revealSnapshots", () => {
      // The directory is created lazily by the first snapshot, so before any
      // Undo this command used to reveal a path that does not exist — which on
      // macOS does nothing at all, and reads as a broken safety net.
      const dir = store.snapshotsLocation();
      ensureDir(dir);
      const count = listDir(dir).filter((n) => !n.endsWith(".json")).length;
      if (count === 0) {
        void vscode.window.showInformationMessage(
          "No recovery snapshots yet. One is saved automatically before every Undo."
        );
        return;
      }
      void vscode.commands.executeCommand(
        "revealFileInOS",
        vscode.Uri.file(dir)
      );
    })
  );

  /** Keep / Undo from a resolved line or caret position, with its excuses. */
  function keepResolved(ref: HunkRef | "baseline-side" | undefined): void {
    if (!ref || ref === "baseline-side") {
      void vscode.window.showInformationMessage(explainNoHunk(ref));
      return;
    }
    keep(
      store.keepHunk(ref.path, ref.index, ref.fingerprint),
      `${pluralChanges(1)} in ${shortName(ref.path)}`
    );
  }

  async function undoResolved(
    ref: HunkRef | "baseline-side" | undefined
  ): Promise<void> {
    if (!ref || ref === "baseline-side") {
      void vscode.window.showInformationMessage(explainNoHunk(ref));
      return;
    }
    if (!(await confirmDestructive(store, [ref.path], "change"))) {
      return;
    }
    await undo(
      [ref.path],
      `${pluralChanges(1)} in ${shortName(ref.path)}`,
      () => store.undoHunk(ref.path, ref.index, ref.fingerprint)
    );
  }

  // --- live recompute on edits/saves --------------------------------------
  const debouncers = new Map<string, NodeJS.Timeout>();
  const scheduleRecompute = (fsPath: string) => {
    if (!store.isTracked(fsPath)) {
      return;
    }
    const prev = debouncers.get(fsPath);
    if (prev) {
      clearTimeout(prev);
    }
    debouncers.set(
      fsPath,
      setTimeout(() => {
        debouncers.delete(fsPath);
        store.recompute(fsPath);
      }, 200)
    );
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== "file") {
        return;
      }
      // Claude writes to disk and VS Code reloads the document, which leaves it
      // clean; the user typing leaves it dirty. That is the only signal the stable
      // API gives us for "whose change is this", and it is enough to warn before an
      // Undo throws the user's own work away.
      //
      // The two halves have to be tested on their own events. A first keystroke in
      // a clean document arrives as *two*: the content change, fired while the
      // document is still clean, and then a `contentChanges: []` notification once
      // the dirty flag is set. Requiring both at once — which is what the single
      // guard above this used to do — meant the opening edit of every editing
      // session went unrecorded, and with it the flag that makes Undo ask first.
      if (e.document.isDirty && !store.isApplyingEdit()) {
        store.noteUserEdit(e.document.uri.fsPath);
      }
      if (e.contentChanges.length > 0) {
        scheduleRecompute(e.document.uri.fsPath);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme === "file") {
        store.recompute(doc.uri.fsPath);
      }
    })
  );

  // --- context keys, status and auto-open ---------------------------------
  const statusChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(statusChanged);

  // Reading the registration means parsing a file the user hand-edits, so every
  // read is guarded: an unexpected shape must not be able to break the status bar,
  // the menus or the settings panel.
  const currentHookState = (): HookState => {
    try {
      return hooksState(workspaceRoot, context.extensionPath, stateDir);
    } catch (err) {
      log(`could not read the hook registration: ${String(err)}`);
      return "missing";
    }
  };

  const panelStatus = (): PanelStatus => ({
    hooks: currentHookState(),
    hooksEnabled: settings.useHooks(),
    transcriptEnabled: settings.useTranscript(),
    pendingFiles: store.count(),
    pendingChanges: store
      .getTracked()
      .reduce((total, file) => total + file.hunks.length, 0),
    unreviewable: store.getUnreviewable().length,
  });

  const refreshHookContext = () => {
    const installed = currentHookState() === "ok";
    void vscode.commands.executeCommand(
      "setContext",
      HOOKS_INSTALLED_KEY,
      installed
    );
    statusChanged.fire();
  };

  const updateActiveContext = () => {
    const ed = vscode.window.activeTextEditor;
    const fsPath = ed ? trackablePath(ed.document.uri) : undefined;
    void vscode.commands.executeCommand(
      "setContext",
      ACTIVE_TRACKED_KEY,
      !!fsPath && store.isTracked(fsPath)
    );
    void vscode.commands.executeCommand(
      "setContext",
      HAS_CHANGES_KEY,
      store.count() > 0
    );
  };

  const updateMenuContext = () =>
    void vscode.commands.executeCommand(
      "setContext",
      EXPLORER_MENU_KEY,
      settings.explorerContextMenu()
    );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateActiveContext),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeKeepUndo.explorerContextMenu")) {
        updateMenuContext();
      }
      if (settings.affectsUs(e)) {
        statusChanged.fire();
      }
    }),
    // The hooks live in a file Claude Code, the user and we all write to, so the
    // welcome view's "install" button has to follow it rather than a snapshot
    // taken at activation.
    watchHookSettings(folder, refreshHookContext)
  );
  updateActiveContext(); // the first editor is already open at activation time
  updateMenuContext();

  const opened = new Set<string>();
  context.subscriptions.push(
    store.onDidChange((uri) => {
      updateActiveContext();
      statusChanged.fire();
      if (!uri) {
        // Bulk change: forget every path that is no longer pending, so a later
        // edit to the same file can auto-open again.
        for (const fsPath of [...opened]) {
          if (!store.isTracked(fsPath)) {
            opened.delete(fsPath);
          }
        }
        return;
      }
      if (!store.isTracked(uri.fsPath)) {
        opened.delete(uri.fsPath);
      }
    }),
    // Auto-open follows *detection*, never `onDidChange`. That event also fires
    // from the debounced recompute — so on essentially every keystroke burst — and
    // from `noteUserEdit`, and nothing in it distinguishes those from Claude
    // writing the file. Driving auto-open from it meant that after any window
    // reload with pending changes, the first character the user typed in a tracked
    // file opened a diff tab and took the focus mid-sentence.
    store.onDidDetect((uri) => {
      const fsPath = uri.fsPath;
      if (!settings.autoOpenDiff() || opened.has(fsPath)) {
        return;
      }
      opened.add(fsPath);
      void openDiff(fsPath);
    })
  );

  // Pending recompute timers must not outlive the store they write to.
  context.subscriptions.push({
    dispose() {
      for (const timer of debouncers.values()) {
        clearTimeout(timer);
      }
      debouncers.clear();
    },
  });

  // --- detection -----------------------------------------------------------
  store.refreshFromDisk(); // load baselines left by hooks or a previous session

  // Both detectors follow their setting for the life of the window. They used to
  // be constructed inside one-shot `if` blocks at activation and never
  // reconciled, so turning either one off left it running — still polling, still
  // pushing entries into the changes view — while the extension's own settings
  // panel, which reads both values live, drew a chip saying it was off. Turning
  // one on did nothing at all until a reload, with no hint that one was needed.
  let hookWatcher: KeepUndoWatcher | undefined;
  let transcript: TranscriptWatcher | undefined;

  const syncDetectors = (): void => {
    if (settings.useHooks() && !hookWatcher) {
      hookWatcher = new KeepUndoWatcher(stateDir, store);
      // An extension update moves the install directory, which silently breaks
      // the recorded hook command. Repair it before reporting the state.
      //
      // Guarded because this parses a file the user hand-edits, and it used to be
      // able to throw on valid JSON in an unexpected shape — aborting activation
      // after the detection watchers were registered but before the menus, the
      // status bar and the returned API, which took the transcript channel down
      // with it even though that channel does not involve hooks at all.
      let state: HookState = "missing";
      try {
        state = repairHooksIfStale(
          workspaceRoot,
          context.extensionPath,
          stateDir,
          log,
          context.workspaceState
        );
      } catch (err) {
        log(`could not inspect the hook registration: ${String(err)}`);
      }
      log(
        state === "ok"
          ? "Hooks detected: real-time detection active."
          : `Hooks not active (${state}).`
      );
    } else if (!settings.useHooks() && hookWatcher) {
      hookWatcher.dispose();
      hookWatcher = undefined;
      log("Hook watcher stopped.");
    }

    if (settings.useTranscript() && !transcript) {
      transcript = new TranscriptWatcher(workspaceRoot, store, log);
      transcript.start();
      log("Transcript watcher started.");
    } else if (!settings.useTranscript() && transcript) {
      transcript.dispose();
      transcript = undefined;
      // Its `dispose` only stops its own timers. The unreviewable entries it
      // pushed into the store stay in the changes view otherwise — which is
      // exactly the noise someone turning the reader off is trying to escape.
      store.clearUnreviewable();
      log("Transcript watcher stopped.");
    }
  };

  syncDetectors();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("claudeKeepUndo.detection.useHooks") ||
        e.affectsConfiguration("claudeKeepUndo.detection.useTranscript")
      ) {
        syncDetectors();
        statusChanged.fire();
      }
    }),
    {
      dispose() {
        hookWatcher?.dispose();
        transcript?.dispose();
      },
    }
  );

  refreshHookContext();
  void maybePromptInstall(context, workspaceRoot, stateDir).then(
    refreshHookContext
  );

  return { stateDir, store };
}

export async function deactivate(): Promise<void> {
  // Release the temporary diff-editor overrides and *wait* for the writes.
  // dispose() cannot be awaited, so without this a shutdown can leave the user's
  // global settings permanently altered.
  await layoutController?.flush();
  layoutController = undefined;
}

/** Watch the two files a hook registration can live in. */
function watchHookSettings(
  folder: vscode.WorkspaceFolder,
  onChange: () => void
): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, ".claude/settings*.json")
  );
  const listeners = [
    watcher.onDidCreate(onChange),
    watcher.onDidChange(onChange),
    watcher.onDidDelete(onChange),
  ];
  return {
    dispose() {
      for (const l of listeners) {
        l.dispose();
      }
      watcher.dispose();
    },
  };
}

function explainNoHunk(ref: "baseline-side" | undefined): string {
  return ref === "baseline-side"
    ? "Keep and Undo act on the right-hand side of the diff — the file itself. Use the line numbers there."
    : "No Claude change on this line.";
}

// --- destructive-action confirmation ---------------------------------------

type UndoScope = "change" | "file" | "all";

/**
 * The store cannot attribute individual lines, so any file the user has typed in
 * since the baseline was recorded may contain their work as well as Claude's.
 * Name that risk before overwriting it. Every Undo also leaves a recoverable
 * snapshot, goes through the editor's undo stack, and can be put back from the
 * notification it produces — but a dialog is the only thing that stops the
 * mistake before it happens.
 */
async function confirmDestructive(
  store: ChangeStore,
  paths: string[],
  scope: UndoScope
): Promise<boolean> {
  const risky = paths.filter((p) => store.isUserTouched(p));
  const created = paths.filter((p) => store.wouldDelete(p));
  const count = paths.length;

  // Deleting a file is a heavier outcome than rewriting one, so it is always
  // named and always confirmed — whatever `confirmUndo` is set to, including for
  // a single file, where an ordinary Undo goes through on the click alone.
  if (created.length > 0) {
    const list = created
      .slice(0, 5)
      .map((p) => path.basename(p))
      .join(", ");
    const more = created.length > 5 ? ` and ${created.length - 5} more` : "";
    const ok = await vscode.window.showWarningMessage(
      `Undo will delete ${pluralFiles(created.length)} Claude created: ${list}${more}.`,
      {
        modal: true,
        detail:
          (risky.length > 0
            ? "You have also edited some of these files since Claude did.\n\n"
            : "") +
          (count > created.length
            ? `The other ${
                count - created.length === 1
                  ? "file is"
                  : `${count - created.length} files are`
              } restored to their previous content.\n\n`
            : "") +
          "A copy of each is saved first (Claude Keep/Undo: Reveal Recovery Snapshots), and the deletion can also be reversed with Ctrl+Z / Cmd+Z.",
      },
      created.length === 1 ? "Delete File" : "Delete Files"
    );
    return ok !== undefined;
  }

  const mode = settings.confirmUndo();
  if (mode === "never") {
    return true;
  }

  // Undoing a single change rewrites that change's lines and nothing else, so
  // the whole-file warning below — "your own work in this file goes too" — does
  // not apply to it, and firing it here would train people to click through.
  //
  // That reasoning only holds for a file the user has not touched. The store
  // re-diffs baseline against current after every keystroke, so a line the user
  // typed next to Claude's edit is merged into the *same* hunk and the splice
  // takes it with it. This branch used to return before `risky` was ever
  // consulted, which made `confirmUndo: "risky"` — the default, documented as
  // "asks when you have edited the file yourself since Claude did" — silently
  // exempt every per-hunk Undo.
  if (scope === "change" && risky.length === 0) {
    if (mode !== "always") {
      return true;
    }
    const ok = await vscode.window.showWarningMessage(
      unriskyPrompt(scope, count, paths),
      { modal: true },
      "Undo"
    );
    return ok !== undefined;
  }

  if (risky.length === 0) {
    // Undoing one thing the user has not touched: the click is the intent.
    if (scope !== "all" && mode !== "always") {
      return true;
    }
    const ok = await vscode.window.showWarningMessage(
      unriskyPrompt(scope, count, paths),
      { modal: true },
      scope === "all" ? "Undo All" : "Undo"
    );
    return ok !== undefined;
  }

  const names = risky
    .slice(0, 5)
    .map((p) => path.basename(p))
    .join(", ");
  const more = risky.length > 5 ? ` and ${risky.length - 5} more` : "";
  // The scope belongs in the strongest confirmation too. This branch used to
  // ignore it, so an Undo All over forty files with one of them hand-edited
  // produced a dialog that described a single file and offered "Undo Anyway" —
  // the safer-looking case was the one that said less.
  const risk = `You have ${
    scope === "all" ? "also " : ""
  }edited ${names}${more} since Claude did, so your own changes there will be discarded too.`;
  const ok = await vscode.window.showWarningMessage(
    scope === "all"
      ? `Undo all of Claude's changes in ${pluralFiles(count)}?`
      : scope === "change"
        ? // Not "the whole file": saying so here would be false, and a warning
          // that overstates what it is about is one people learn to dismiss.
          `You have edited ${names}${more} since Claude did. This change's lines may include your own edits, and Undo will discard them.`
        : `You have edited ${names}${more} since Claude did. Undo restores the whole file, so your own changes there will be discarded too.`,
    {
      modal: true,
      detail:
        (scope === "all" ? `${risk}\n\n` : "") +
        "A copy of the current content is saved first (Claude Keep/Undo: Reveal Recovery Snapshots), and Undo can also be reversed with Ctrl+Z / Cmd+Z in the editor.",
    },
    scope === "all" ? "Undo All" : "Undo Anyway"
  );
  return ok !== undefined;
}

function unriskyPrompt(
  scope: UndoScope,
  count: number,
  paths: string[]
): string {
  if (scope === "all") {
    return `Undo all of Claude's changes in ${pluralFiles(count)}? ${
      count === 1 ? "It" : "They"
    } will be restored to the previous state.`;
  }
  const name = paths[0] ? path.basename(paths[0]) : "this file";
  return scope === "file"
    ? `Undo all of Claude's changes in ${name}?`
    : `Undo this change in ${name}?`;
}

// --- multi-file review -----------------------------------------------------

/**
 * Open every pending file in one Multi Diff Editor tab via the built-in
 * `vscode.changes` command, whose resource list is `[label, original, modified]`
 * triples.
 */
async function openAllChanges(store: ChangeStore): Promise<void> {
  const tracked = store.getTracked();
  if (tracked.length === 0) {
    void vscode.window.showInformationMessage("No Claude changes to review.");
    return;
  }
  const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = tracked.map(
    (file) => [
      vscode.Uri.file(file.path),
      toBaselineUri(file.path),
      vscode.Uri.file(file.path),
    ]
  );
  const title = `Claude: ${pluralFiles(tracked.length)} to review`;
  try {
    await vscode.commands.executeCommand("vscode.changes", title, resources);
  } catch {
    void vscode.window.showErrorMessage(
      "Could not open the multi-file diff editor. It requires VS Code 1.86 or newer."
    );
  }
}

// --- argument resolution ---------------------------------------------------

/**
 * Where the review state lives: VS Code's per-workspace storage, outside the
 * repository. `storageUri` is undefined only without a workspace, which is
 * already ruled out; the global-storage fallback keeps the code total.
 */
function resolveStateDir(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): string {
  return (
    context.storageUri?.fsPath ??
    path.join(
      context.globalStorageUri.fsPath,
      "workspaces",
      pathKey(workspaceRoot)
    )
  );
}

/** The real file path behind a uri, including the baseline side of our diff. */
function trackablePath(uri: vscode.Uri): string | undefined {
  if (uri.scheme === "file" || uri.scheme === BASELINE_SCHEME) {
    return uri.fsPath;
  }
  return undefined;
}

/**
 * Coerce a value to a Uri. Menu arguments cross the extension-host RPC boundary
 * and are normally revived into real Uri instances, but accepting the plain
 * serialized shape as well means an unexpected payload degrades to "not found"
 * instead of silently resolving to the active editor.
 */
function toUri(value: unknown): vscode.Uri | undefined {
  if (value instanceof vscode.Uri) {
    return value;
  }
  if (isRecord(value) && typeof value.scheme === "string") {
    try {
      return vscode.Uri.from({
        scheme: value.scheme,
        authority: typeof value.authority === "string" ? value.authority : "",
        path: typeof value.path === "string" ? value.path : "",
        query: typeof value.query === "string" ? value.query : "",
        fragment: typeof value.fragment === "string" ? value.fragment : "",
      });
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Commands are invoked from many surfaces, each passing a different shape:
 * a plain path, a Uri, a tree node, a `SourceControlResourceState` (Source
 * Control view), or a `CommentThread` (inline comment toolbar).
 */
function resolvePath(arg: unknown): string | undefined {
  if (typeof arg === "string") {
    return arg;
  }
  const direct = toUri(arg);
  if (direct) {
    return trackablePath(direct) ?? direct.fsPath;
  }
  if (isRecord(arg)) {
    const resource = toUri(arg.resourceUri); // SourceControlResourceState
    if (resource) {
      return resource.fsPath;
    }
    const owner = toUri(arg.uri); // CommentThread
    if (owner) {
      return trackablePath(owner) ?? owner.fsPath;
    }
    if (isChangeNode(arg)) {
      return arg.path;
    }
  }
  const ed = vscode.window.activeTextEditor;
  return ed ? trackablePath(ed.document.uri) : undefined;
}

interface HunkRef {
  path: string;
  index: number;
  fingerprint?: string;
}

function resolveHunk(
  store: ChangeStore,
  arg: unknown,
  idx: unknown,
  fingerprint: unknown
): HunkRef | undefined {
  if (isChangeNode(arg) && arg.type === "hunk") {
    return { path: arg.path, index: arg.index, fingerprint: arg.fingerprint };
  }
  // A comment thread carries no index; resolve it from the line it sits on.
  const thread = asCommentThread(arg);
  if (thread) {
    return atLine(store, thread.path, thread.line);
  }
  const p = resolvePath(arg);
  if (p !== undefined && typeof idx === "number") {
    return {
      path: p,
      index: idx,
      fingerprint: typeof fingerprint === "string" ? fingerprint : undefined,
    };
  }
  return undefined;
}

/** Resolve the hunk at a 0-based line, carrying its current fingerprint. */
function atLine(
  store: ChangeStore,
  path: string,
  line: number
): HunkRef | undefined {
  const index = store.hunkIndexAtLine(path, line);
  if (index === undefined) {
    return undefined;
  }
  return {
    path,
    index,
    fingerprint: store.get(path)?.hunks[index]?.fingerprint,
  };
}

/**
 * `editor/lineNumber/context` passes `{ lineNumber, uri }`, 1-based.
 *
 * Only the *modified* side is accepted. `trackablePath` deliberately maps both
 * sides of a Claude diff onto the same real path, but `hunkIndexAtLine` resolves
 * line numbers in current-content coordinates — so a baseline line number would
 * silently select a different hunk wherever an earlier hunk shifted the
 * numbering, and the fingerprint could not catch it (it is derived from whatever
 * index was resolved, so it always agrees with the wrong answer).
 */
function resolveLineArg(
  store: ChangeStore,
  arg: unknown
): HunkRef | "baseline-side" | undefined {
  if (!isRecord(arg) || typeof arg.lineNumber !== "number") {
    return undefined;
  }
  const uri = toUri(arg.uri);
  if (!uri) {
    return undefined;
  }
  if (uri.scheme === BASELINE_SCHEME) {
    return "baseline-side";
  }
  if (uri.scheme !== "file") {
    return undefined;
  }
  return atLine(store, uri.fsPath, arg.lineNumber - 1);
}

/** The change under the caret of the active editor, for the keyboard path. */
function resolveCursor(
  store: ChangeStore
): HunkRef | "baseline-side" | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  if (editor.document.uri.scheme === BASELINE_SCHEME) {
    return "baseline-side";
  }
  if (editor.document.uri.scheme !== "file") {
    return undefined;
  }
  return atLine(
    store,
    editor.document.uri.fsPath,
    editor.selection.active.line
  );
}

/** `scm/change/title` passes `(uri, changes, index)`. */
function resolveLineChange(
  uriArg: unknown,
  changesArg: unknown,
  indexArg: unknown
): { path: string; change: LineChange } | undefined {
  const path = resolvePath(uriArg);
  if (!path || !Array.isArray(changesArg) || typeof indexArg !== "number") {
    return undefined;
  }
  const raw: unknown = changesArg[indexArg];
  if (!isRecord(raw)) {
    return undefined;
  }
  const fields = [
    "originalStartLineNumber",
    "originalEndLineNumber",
    "modifiedStartLineNumber",
    "modifiedEndLineNumber",
  ] as const;
  if (!fields.every((f) => typeof raw[f] === "number")) {
    return undefined;
  }
  return { path, change: raw as unknown as LineChange };
}

function isRecord(arg: unknown): arg is Record<string, unknown> {
  return !!arg && typeof arg === "object";
}

/** Recognise a `CommentThread` argument and reduce it to (path, anchor line). */
function asCommentThread(
  arg: unknown
): { path: string; line: number } | undefined {
  if (!isRecord(arg) || !Array.isArray(arg.comments)) {
    return undefined;
  }
  const uri = toUri(arg.uri);
  const path = uri ? trackablePath(uri) : undefined;
  if (!path) {
    return undefined;
  }
  const range = arg.range;
  const line =
    isRecord(range) &&
    isRecord(range.start) &&
    typeof range.start.line === "number"
      ? range.start.line
      : 0;
  return { path, line };
}

function isChangeNode(arg: unknown): arg is ChangeNode {
  return (
    isRecord(arg) &&
    "type" in arg &&
    "path" in arg &&
    typeof (arg as { path: unknown }).path === "string"
  );
}

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}
