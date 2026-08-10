import * as vscode from "vscode";
import { ChangeStore } from "../changeStore";
import { readSidecar } from "../util";

/**
 * Watches the baselines directory and refreshes the store when the hooks write
 * to it. This is the real-time channel that complements the transcript watcher.
 *
 * Only `baselines/**` is watched. The event log and the staging directory also
 * live under the state directory and change on every single tool call, and
 * refreshing the whole store for those was pure churn.
 *
 * Events are resolved back to the file they describe and recomputed one by one.
 * Calling the whole-store `refreshFromDisk()` for each event instead meant a run
 * touching a hundred files paid a hundred full diffs *per event*, all on the
 * extension host thread. Two cases still fall back to the full sweep: a deletion,
 * whose sidecar is gone along with the file it named, and a baseline whose
 * sidecar has not been written yet — both unresolvable, and both cheaper to
 * re-sweep than to lose.
 *
 * The extension writes baselines too, so a refresh triggered by our own write is
 * deferred rather than run: `ChangeStore.wroteStateRecently()` marks the window,
 * and deferring (instead of dropping) means a hook write that lands inside that
 * window is still picked up.
 */
export class KeepUndoWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher;
  private timer: NodeJS.Timeout | undefined;
  /** Baseline content paths touched since the last flush. */
  private readonly touched = new Set<string>();
  private needsFullRefresh = false;

  constructor(
    stateDir: string,
    private readonly store: ChangeStore
  ) {
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(stateDir),
      "baselines/**"
    );
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidCreate((uri) => this.note(uri));
    this.watcher.onDidChange((uri) => this.note(uri));
    this.watcher.onDidDelete(() => {
      // The sidecar that said which file this baseline belonged to is gone too.
      this.needsFullRefresh = true;
      this.schedule();
    });
  }

  /**
   * Record a touched baseline. The content file and its `.json` sidecar are two
   * events for one baseline, so both collapse onto the content path.
   */
  private note(uri: vscode.Uri): void {
    const fsPath = uri.fsPath;
    if (fsPath.endsWith(".tmp")) {
      return; // an atomicWrite in flight; the rename fires its own event
    }
    this.touched.add(
      fsPath.endsWith(".json") ? fsPath.slice(0, -".json".length) : fsPath
    );
    this.schedule();
  }

  private schedule(delay = 120): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.store.wroteStateRecently()) {
        this.schedule(250); // our own write; look again once it has settled
        return;
      }
      this.flush();
    }, delay);
  }

  private flush(): void {
    const touched = [...this.touched];
    this.touched.clear();
    if (this.needsFullRefresh) {
      this.needsFullRefresh = false;
      this.store.refreshFromDisk();
      return;
    }
    let resolved = 0;
    for (const contentPath of touched) {
      const sidecar = readSidecar(contentPath);
      if (sidecar) {
        this.store.reloadBaseline(sidecar.path);
        resolved++;
      }
    }
    // A baseline whose sidecar has not landed yet cannot be resolved to a path.
    // Rather than lose it, fall back to the sweep that finds everything.
    if (resolved < touched.length) {
      this.store.refreshFromDisk();
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.watcher.dispose();
  }
}
