import * as path from "path";
import * as vscode from "vscode";
import { ChangeStore } from "../changeStore";
import {
  listDir,
  readFileSafe,
  readSidecar,
  removeFile,
  unreviewableDir,
} from "../util";

/**
 * A note the hook left about a file it could not establish a baseline for.
 *
 * It runs in its own process and cannot call into the extension, so the
 * explanation is written to disk and drained here. Transient by design, matching
 * `ChangeStore.unreviewable`, which is an in-memory map wiped on reload: the
 * note is read, handed to the store, and deleted.
 */
interface UnreviewableNote {
  path: string;
  reason: string;
  remedy?: string;
  ts: number;
}

/** A note older than this is stale bookkeeping, not a pending explanation. */
const NOTE_TTL_MS = 24 * 3600_000;

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
  private inheritedWatcher: vscode.FileSystemWatcher;
  private timer: NodeJS.Timeout | undefined;
  /** Baseline content paths touched since the last flush. */
  private readonly touched = new Set<string>();
  private needsFullRefresh = false;

  private readonly notesDir: string;

  constructor(
    stateDir: string,
    private readonly store: ChangeStore
  ) {
    const parent = path.dirname(stateDir);
    this.inheritedWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(parent), "*/baselines/**")
    );
    this.notesDir = unreviewableDir(stateDir);
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(stateDir),
      "{baselines,unreviewable}/**"
    );
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    // Notes written while this window was closed, or before the watcher was
    // wired up, would otherwise sit on disk unread.
    this.drainNotes();
    this.watcher.onDidCreate((uri) => this.note(uri));
    this.watcher.onDidChange((uri) => this.note(uri));
    this.watcher.onDidDelete(() => {
      // The sidecar that said which file this baseline belonged to is gone too.
      this.needsFullRefresh = true;
      this.schedule();
    });
    this.inheritedWatcher.onDidCreate((uri) => this.note(uri));
    this.inheritedWatcher.onDidChange((uri) => this.note(uri));
    this.inheritedWatcher.onDidDelete((uri) => {
      if (!this.store.coversInheritedState(uri.fsPath)) {
        return;
      }
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
    if (fsPath.startsWith(this.notesDir + path.sep)) {
      this.drainNotes();
      return;
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

  /**
   * Read every note the hook left, hand it to the store, and delete it.
   *
   * A note whose file already has a baseline is dropped without being ingested:
   * a later command may have recovered it exactly, and the changes view lists
   * tracked files and unreviewable ones separately, so keeping both would show
   * the same file twice.
   */
  private drainNotes(): void {
    for (const entry of listDir(this.notesDir)) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const file = path.join(this.notesDir, entry);
      const raw = readFileSafe(file);
      if (raw === undefined) {
        continue;
      }
      let note: UnreviewableNote | undefined;
      try {
        const parsed = JSON.parse(raw) as UnreviewableNote;
        note =
          parsed &&
          typeof parsed.path === "string" &&
          typeof parsed.reason === "string"
            ? parsed
            : undefined;
      } catch {
        note = undefined;
      }
      // Removed either way: an unparseable note is not going to become readable,
      // and one that has been acted on is spent.
      removeFile(file);
      if (!note || Date.now() - (Number(note.ts) || 0) > NOTE_TTL_MS) {
        continue;
      }
      if (this.store.hasBaseline(note.path)) {
        continue; // recovered exactly after all
      }
      this.store.noteUnreviewable(
        note.path,
        note.remedy ? `${note.reason}. ${note.remedy}` : note.reason
      );
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.watcher.dispose();
    this.inheritedWatcher.dispose();
  }
}
