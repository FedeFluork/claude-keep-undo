import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  computeHunks,
  eolOnlyHunk,
  Hunk,
  hunkCovers,
  hunkLineRange,
  keepHunkInBaseline,
  LineChange,
  lineChangeToHunk,
  textDigest,
  undoHunkInCurrent,
} from "./diff";
import {
  atomicCopy,
  atomicWrite,
  BASELINE_SCHEME,
  baselinesDir,
  BytesReadResult,
  ensureDir,
  fileExists,
  legacyStateDir,
  listDir,
  looksBinary,
  moveDir,
  normalizePath,
  pathKey,
  pendingDir,
  readFileBytesResult,
  readFileSafe,
  readSidecar,
  removeFile,
  sidecarPath,
  snapshotsDir,
  uniqueSuffix,
} from "./util";
import { trackOutsideWorkspace } from "./settings";

export interface TrackedFile {
  /** Absolute filesystem path. */
  path: string;
  /** Content of the file before Claude started editing it. */
  baseline: string;
  /** Pending differences between baseline and the current content. */
  hunks: Hunk[];
  /**
   * True once the user has typed in this file since the baseline was recorded.
   * The store cannot attribute individual lines, so this is a file-level warning
   * flag: an Undo here may discard the user's own work, not just Claude's.
   */
  userTouched: boolean;
  /** The file no longer exists: Keep forgets it, Undo restores it. */
  missing: boolean;
  /** The two versions were too different to split into per-line hunks. */
  degraded: boolean;
  /**
   * Claude created this file: there was nothing here before. Keep accepts it,
   * and Undo *deletes* it rather than writing the empty baseline back — an
   * empty file left on disk is not the state the user is asking to return to.
   */
  created: boolean;
  /**
   * Digest of the current content the hunks were computed from, so a recompute
   * triggered by an unrelated event can return without re-diffing the file.
   */
  digest: string;
}

/** A file Claude changed that cannot be reviewed, and why. */
export interface Unreviewable {
  path: string;
  reason: string;
}

/**
 * The "leave this file alone entirely" rule, supplied by {@link IgnoreConfig}.
 *
 * An interface rather than the class itself so the store keeps no dependency on
 * the settings, the ignore file or the watcher behind them — and so a test can
 * hand it a predicate.
 */
export interface IgnorePredicate {
  isIgnored(absPath: string): boolean;
}

/** Reviews nothing is ignored: the behaviour before this setting existed. */
const IGNORE_NOTHING: IgnorePredicate = { isIgnored: () => false };

/**
 * Outcome of a Keep/Undo action, so the UI can explain a refusal.
 *
 * `applied-modified` is a *success*: the file was written, but saving it ran the
 * workbench save participants — format-on-save, organise imports, insert-final-
 * newline — and one of them rewrote the content, so the file is legitimately
 * still under review. Collapsing it into `failed` told the user "Undo could not
 * be written to disk" *after* their pre-Undo content had already been replaced,
 * and suppressed the Restore button that was the only way back.
 */
export type ApplyResult =
  "applied" | "applied-modified" | "stale" | "failed" | "unavailable";

/**
 * What an Undo left behind, recorded so a later Restore can tell the file has
 * moved on since.
 */
export interface PostUndoState {
  /** Digest of the content the Undo left, or undefined if it deleted the file. */
  content: string | undefined;
  /** Digest of the baseline still in place, or undefined if the Undo resolved it. */
  baseline: string | undefined;
}

/** A file's reviewable state, captured before an Undo so it can be put back. */
export interface UndoSnapshot {
  path: string;
  /** Content before the Undo, or undefined if the file was not readable. */
  content: string | undefined;
  /** The baseline that was in effect, so the file returns *under review*. */
  baseline: string;
  created: boolean;
  /**
   * Stamped in after the Undo lands (see `stampPostUndo`). A Restore compares it
   * against the file and the baseline as they are *now* and refuses when either
   * has moved: re-applying a snapshot from twenty minutes ago is a whole-file
   * overwrite of everything done since.
   */
  postUndo?: PostUndoState;
}

/** Whether a recovery copy was actually taken before a destructive action. */
type SnapshotResult = "written" | "nothing-to-copy" | "failed";

/** Outcome of undoing a set of files, one bucket per distinct outcome. */
export interface UndoBatchResult {
  /** Files restored to their baseline, byte for byte. */
  applied: number;
  /** Restored, then rewritten by a save participant: still under review. */
  reformatted: string[];
  /** Files that could not be written at all. */
  failed: string[];
  /** Files Claude created, and Undo therefore removed. */
  deleted: string[];
  /** Files no longer pending by the time their turn came. */
  skipped: string[];
}

/** How long a snapshot taken before a destructive action is kept around. */
const SNAPSHOT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const SNAPSHOT_MAX = 200;

/**
 * Above this size an Undo writes straight to disk instead of opening the
 * document first. Routing through a `WorkspaceEdit` is what puts Undo on the
 * editor's undo stack, but opening a multi-megabyte file that nobody had open
 * wakes language servers for no benefit.
 */
const OPEN_DOCUMENT_LIMIT_BYTES = 512 * 1024;

/** Window during which the watcher treats a state change as one of our own. */
const SELF_WRITE_WINDOW_MS = 400;

/**
 * How long a baseline may sit on disk without a descriptor before the sweep is
 * entitled to call it an orphan. Promotion writes the content and the descriptor
 * as two operations, so the incomplete state is legitimate — briefly.
 */
const ORPHAN_GRACE_MS = 5_000;

/**
 * Upper bound on remembered user edits. Untracked paths are recorded too — that
 * is the point — so without a bound the set grows with every file the user types
 * in for as long as the window lives.
 */
const USER_TOUCHED_MAX = 2048;

/**
 * Single source of truth for "what has Claude changed and not yet reviewed".
 *
 * State is backed by files under VS Code's per-workspace storage directory —
 * deliberately *outside* the repository, because baselines and snapshots are
 * verbatim copies of the user's source and one `git add -A` away from committing
 * whatever secrets those files held:
 *   - baselines/<key>        raw original content (before Claude's edits)
 *   - baselines/<key>.json   { path, ts } — makes the baseline self-describing
 *
 * Each baseline carries its own sidecar rather than sharing one index file: the
 * hook process and the extension both create baselines, and a shared file would
 * lose updates whenever the two interleave a read-modify-write.
 *
 * A file is "tracked" while a baseline exists and differs from the current
 * content. Keep folds the change into the baseline; Undo reverts the file.
 * Either way, once baseline === current the entry resolves and disappears.
 */
export class ChangeStore implements vscode.Disposable {
  private tracked = new Map<string, TrackedFile>();
  private userTouched = new Set<string>();
  private unreviewable = new Map<string, string>();
  /** Paths whose baseline records that Claude created the file. */
  private createdFiles = new Set<string>();
  private applying = 0;
  private lastStateWrite = 0;
  private disposed = false;
  private trackOutsideWorkspace = false;
  private readonly normalizedRoot: string;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<
    vscode.Uri | undefined
  >();
  /** Fires with a specific uri when one file changes, or undefined for "all". */
  readonly onDidChange = this._onDidChange.event;
  private readonly _onDidDetect = new vscode.EventEmitter<vscode.Uri>();
  /**
   * Fires when a change *by Claude* is newly detected in a file.
   *
   * `onDidChange` cannot answer that question. It also fires from the debounced
   * recompute — so on essentially every keystroke burst — and from
   * `noteUserEdit`, and a listener has no way to tell those apart from a
   * detection. That is how "open the diff automatically" came to fire on the
   * user's own typing: after a window reload with pending changes, the first
   * character typed in a tracked file opened a diff tab and took the focus
   * mid-sentence.
   */
  readonly onDidDetect = this._onDidDetect.event;

  constructor(
    private readonly stateDir: string,
    private readonly workspaceRoot: string,
    private readonly log: (msg: string) => void,
    private readonly ignore: IgnorePredicate = IGNORE_NOTHING
  ) {
    this.normalizedRoot = normalizePath(workspaceRoot);
    this.readScopeSetting();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("claudeKeepUndo.trackOutsideWorkspace")) {
          this.readScopeSetting();
          this.refreshFromDisk();
        }
      })
    );
    this.migrateLegacyState();
    this.pruneSnapshots();
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChange.dispose();
    this._onDidDetect.dispose();
  }

  private readScopeSetting(): void {
    this.trackOutsideWorkspace = trackOutsideWorkspace();
  }

  /**
   * Is this path one we should be reviewing at all?
   *
   * Claude edits files outside the open folder routinely — its own settings, a
   * scratch file, a sibling repository it was asked to read. Tracking those puts
   * verbatim copies of them into *this* workspace's state directory and lists
   * them in a view whose paths are relative to a root they are not under.
   */
  isInScope(absPath: string): boolean {
    if (this.trackOutsideWorkspace) {
      return true;
    }
    const rel = path.relative(this.normalizedRoot, normalizePath(absPath));
    if (rel === "" || path.isAbsolute(rel)) {
      return false;
    }
    // `startsWith("..")` also matches a directory genuinely named `..cache`,
    // which would then be silently excluded from review.
    return rel !== ".." && !rel.startsWith(`..${path.sep}`);
  }

  /**
   * Has the user asked for this file to be left alone?
   *
   * Deliberately a separate question from {@link isInScope}, even though the two
   * are consulted together everywhere. Being outside the workspace is a fact
   * about the path; being ignored is an instruction, it can be withdrawn, and
   * the two want different words in the log when a baseline is dropped.
   */
  isIgnored(absPath: string): boolean {
    return this.ignore.isIgnored(absPath);
  }

  /** Both questions at once, for the callers that only need a yes or no. */
  private shouldTrack(absPath: string): boolean {
    return this.isInScope(absPath) && !this.isIgnored(absPath);
  }

  private fire(uri: vscode.Uri | undefined): void {
    if (!this.disposed) {
      this._onDidChange.fire(uri);
    }
  }

  // --- queries -------------------------------------------------------------

  getTracked(): TrackedFile[] {
    return [...this.tracked.values()].sort((a, b) =>
      a.path.localeCompare(b.path)
    );
  }

  isTracked(absPath: string): boolean {
    return this.tracked.has(absPath);
  }

  /** Whether a baseline (from a hook or the transcript) exists for this path. */
  hasBaseline(absPath: string): boolean {
    return fileExists(this.baselinePath(absPath));
  }

  get(absPath: string): TrackedFile | undefined {
    return this.tracked.get(absPath);
  }

  count(): number {
    return this.tracked.size;
  }

  /** True while the store itself is writing to a document. */
  isApplyingEdit(): boolean {
    return this.applying > 0;
  }

  /** True when the last change under the state directory was ours. */
  wroteStateRecently(): boolean {
    return Date.now() - this.lastStateWrite < SELF_WRITE_WINDOW_MS;
  }

  isUserTouched(absPath: string): boolean {
    return this.userTouched.has(absPath);
  }

  /** Did Claude create this file? Undo deletes it rather than emptying it. */
  isCreated(absPath: string): boolean {
    return this.createdFiles.has(absPath);
  }

  /** Tracked files the user has also edited by hand — Undo risks their work. */
  userTouchedPaths(): string[] {
    return this.getTracked()
      .filter((f) => f.userTouched)
      .map((f) => f.path);
  }

  /**
   * Files Claude changed that could not be given an exact baseline. They are not
   * reviewable, but staying silent about them would look like the extension
   * simply missed the edit.
   */
  getUnreviewable(): Unreviewable[] {
    return [...this.unreviewable.entries()]
      .map(([p, reason]) => ({ path: p, reason }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  noteUnreviewable(absPath: string, reason: string): void {
    if (this.isIgnored(absPath)) {
      // "Not reviewable" is still a row in the changes view naming the file, and
      // someone who excluded it asked not to be told about it at all.
      return;
    }
    if (this.unreviewable.get(absPath) === reason) {
      return;
    }
    this.unreviewable.set(absPath, reason);
    this.fire(undefined);
  }

  clearUnreviewable(absPath?: string): void {
    if (absPath === undefined) {
      if (this.unreviewable.size === 0) {
        return;
      }
      this.unreviewable.clear();
    } else if (!this.unreviewable.delete(absPath)) {
      return;
    }
    this.fire(undefined);
  }

  /**
   * Record that the user (not Claude, and not this extension) has edited a file.
   * The store cannot tell which lines are whose, so this only raises a flag the
   * UI uses to make destructive actions explicit.
   *
   * Recorded whether or not the file is tracked yet, because the dangerous
   * ordering is exactly the one that used to be thrown away: the user types
   * without saving, Claude then edits the same file, and the baseline is read
   * *from disk* — so the unsaved lines are not in it, and diffing the dirty buffer
   * against it presents the user's own work as Claude's. Undo would discard it,
   * and the warning that exists for that case never fired because the flag was
   * only ever set for files already under review.
   */
  noteUserEdit(absPath: string): void {
    if (this.userTouched.has(absPath)) {
      return;
    }
    this.rememberUserEdit(absPath);
    const entry = this.tracked.get(absPath);
    if (!entry) {
      // Nothing to render yet; `recompute` reads the flag when the entry appears.
      return;
    }
    entry.userTouched = true;
    this.log(`user edit detected in ${absPath} — Undo will be confirmed`);
    this.fire(vscode.Uri.file(absPath));
  }

  /**
   * Add to `userTouched`, keeping it bounded. Now that untracked files are
   * recorded too, the set would otherwise grow with every file the user opens and
   * types in for the lifetime of the window. Tracked paths are never evicted:
   * theirs is the flag that gates a destructive action.
   */
  private rememberUserEdit(absPath: string): void {
    this.userTouched.add(absPath);
    if (this.userTouched.size <= USER_TOUCHED_MAX) {
      return;
    }
    for (const candidate of this.userTouched) {
      if (this.userTouched.size <= USER_TOUCHED_MAX) {
        break;
      }
      if (!this.tracked.has(candidate) && candidate !== absPath) {
        this.userTouched.delete(candidate);
      }
    }
  }

  /**
   * Baseline content for a path (used by the diff content provider and by the
   * quick diff provider).
   *
   * When there is no baseline we deliberately serve the *current* content rather
   * than an empty string: VS Code caches quick diff models per document, so a
   * file that has just been resolved would otherwise keep rendering "the whole
   * file was added" in the gutter until the editor is closed.
   */
  getBaseline(absPath: string): string {
    const t = this.tracked.get(absPath);
    if (t) {
      return t.baseline;
    }
    return (
      readFileSafe(this.baselinePath(absPath)) ?? this.currentContent(absPath)
    );
  }

  /**
   * Index of the hunk covering a 0-based line of the current content, if any.
   * Used by the line-number context menu and the code action provider. A pure
   * deletion occupies no line of its own, so the line just above it counts too.
   */
  hunkIndexAtLine(absPath: string, line: number): number | undefined {
    const t = this.tracked.get(absPath);
    if (!t) {
      return undefined;
    }
    for (let i = 0; i < t.hunks.length; i++) {
      const { start, end } = hunkLineRange(t.hunks[i]);
      const from =
        t.hunks[i].currentLines.length > 0 ? start : Math.max(0, start - 1);
      if (line >= from && line <= end) {
        return i;
      }
    }
    return undefined;
  }

  // --- disk layout ---------------------------------------------------------

  private baselinePath(absPath: string): string {
    return path.join(baselinesDir(this.stateDir), pathKey(absPath));
  }

  private pendingPath(absPath: string): string {
    return path.join(pendingDir(this.stateDir), pathKey(absPath));
  }

  private markStateWrite(): void {
    this.lastStateWrite = Date.now();
  }

  /**
   * `bytes` is the byte length the content is expected to have on disk, which
   * `baselineIsFaithful` re-measures before trusting a baseline. It is omitted
   * only where there is nothing to measure against — a legacy record being given
   * a sidecar it never had.
   */
  private writeSidecar(
    contentPath: string,
    absPath: string,
    created = false,
    bytes?: number
  ): boolean {
    return atomicWrite(
      sidecarPath(contentPath),
      JSON.stringify(
        bytes === undefined
          ? { path: absPath, ts: Date.now(), created }
          : { path: absPath, ts: Date.now(), created, bytes },
        null,
        2
      )
    );
  }

  private writeBaseline(
    absPath: string,
    content: string,
    created = this.createdFiles.has(absPath)
  ): boolean {
    const target = this.baselinePath(absPath);
    this.markStateWrite();
    // The sidecar goes first, and its result is checked. `baselinePaths()`
    // enumerates content files and used to treat one with an unreadable sidecar as
    // an orphan to delete, so a content file that outlived a failed sidecar write
    // was destroyed by the next sweep — taking every unreviewed change in that
    // file with it, after the UI had already reported the action as applied. A
    // sidecar with no content behind it, by contrast, is simply never looked at.
    const previous = readFileSafe(sidecarPath(target));
    if (
      !this.writeSidecar(
        target,
        absPath,
        created,
        // A baseline we produced ourselves *is* a string: its own UTF-8 length is
        // the truth to check later reads against.
        Buffer.byteLength(content, "utf8")
      )
    ) {
      this.log(`failed to write the baseline sidecar for ${absPath}`);
      return false;
    }
    if (!atomicWrite(target, content)) {
      this.log(`failed to write baseline for ${absPath}`);
      // Put the previous descriptor back. Any baseline still sitting there is the
      // one it describes, and leaving the new one — which records a byte length
      // that was never written — would make that content fail its own integrity
      // check and drop the file out of review.
      if (previous === undefined) {
        removeFile(sidecarPath(target));
      } else {
        atomicWrite(sidecarPath(target), previous);
      }
      return false;
    }
    if (created) {
      this.createdFiles.add(absPath);
    } else {
      this.createdFiles.delete(absPath);
    }
    return true;
  }

  /** Every path that currently has a baseline on disk, with its creation flag. */
  private baselinePaths(): { path: string; created: boolean }[] {
    const dir = baselinesDir(this.stateDir);
    const paths: { path: string; created: boolean }[] = [];
    for (const name of listDir(dir)) {
      if (name.endsWith(".json") || name.endsWith(".tmp")) {
        continue;
      }
      const contentPath = path.join(dir, name);
      const sidecar = readSidecar(contentPath);
      if (!sidecar) {
        // `readSidecar` collapses "could not be read" into "is not there", and
        // acting on that conflation destroys data: a transient EACCES, an EMFILE
        // while sweeping hundreds of baselines, or an indexer holding the .json
        // open on Windows would all be read as "orphan" and delete the only copy
        // of the pre-Claude content. Presence is the question that matters here,
        // and it has its own answer.
        if (fileExists(sidecarPath(contentPath))) {
          // A genuinely corrupt descriptor leaves the pair on disk forever, which
          // is a few kilobytes of leak. That is the better failure.
          this.log(`skipping baseline ${name}: its sidecar could not be read`);
          continue;
        }
        if (this.writtenRecently(contentPath)) {
          // A baseline is promoted by renaming the content and *then* writing the
          // descriptor, so having no sidecar yet is the normal state for a few
          // milliseconds. Sweeping inside that window is not evidence of anything.
          continue;
        }
        // Unusable: the content is there but nothing says which file it belongs
        // to. Leaving it would keep it forever, since nothing can ever match it.
        this.log(`dropping orphaned baseline ${name} (no sidecar)`);
        removeFile(contentPath);
        continue;
      }
      if (!this.isInScope(sidecar.path)) {
        // The hook captures whatever Claude touches; scoping is decided here.
        // Dropping it is what the setting asked for, and a new baseline is
        // captured from scratch if it is ever turned back on.
        this.log(`dropping out-of-workspace baseline for ${sidecar.path}`);
        removeFile(contentPath);
        removeFile(sidecarPath(contentPath));
        continue;
      }
      if (this.isIgnored(sidecar.path)) {
        // A rule was added after this baseline was captured, or the hook ran
        // with rules older than the ones in force now. Either way the file is
        // one the user asked not to have copied aside, so the copy goes.
        this.log(`dropping ignored baseline for ${sidecar.path}`);
        removeFile(contentPath);
        removeFile(sidecarPath(contentPath));
        continue;
      }
      paths.push({ path: sidecar.path, created: sidecar.created === true });
    }
    return paths;
  }

  /**
   * Whether a file was written within the window in which a two-step write
   * (content, then descriptor) is legitimately still incomplete.
   */
  private writtenRecently(filePath: string): boolean {
    try {
      return Date.now() - fs.statSync(filePath).mtimeMs < ORPHAN_GRACE_MS;
    } catch {
      return false;
    }
  }

  /** The creation flag recorded alongside a baseline on disk. */
  private readCreatedFlag(absPath: string): boolean {
    return readSidecar(this.baselinePath(absPath))?.created === true;
  }

  /**
   * Lift pre-0.2.0 state out of the repository, and upgrade the even older
   * shared `index.json` layout to per-baseline sidecars on the way.
   */
  private migrateLegacyState(): void {
    const legacy = legacyStateDir(this.workspaceRoot);
    if (!fileExists(legacy)) {
      return;
    }
    if (
      fileExists(this.stateDir) &&
      listDir(baselinesDir(this.stateDir)).length > 0
    ) {
      this.log(`state already migrated; leaving ${legacy} alone`);
      return;
    }
    this.migrateLegacyIndex(legacy);
    if (moveDir(legacy, this.stateDir)) {
      this.log(
        `moved review state out of the workspace: ${legacy} -> ${this.stateDir}`
      );
    } else {
      this.log(`could not move ${legacy} into ${this.stateDir}`);
    }
  }

  private migrateLegacyIndex(legacy: string): void {
    const indexFile = path.join(legacy, "index.json");
    const raw = readFileSafe(indexFile);
    if (raw === undefined) {
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [key, absPath] of Object.entries(
          parsed as Record<string, unknown>
        )) {
          if (typeof absPath !== "string") {
            continue;
          }
          const contentPath = path.join(legacy, "baselines", key);
          if (fileExists(contentPath) && !readSidecar(contentPath)) {
            this.writeSidecar(contentPath, absPath);
          }
        }
      }
    } catch {
      this.log("legacy index.json was unreadable; ignoring it");
    }
    removeFile(indexFile);
  }

  // --- recovery snapshots --------------------------------------------------

  /**
   * Copy a file's current content aside before a destructive action, so an Undo
   * fired on the wrong file — or on work the store mistook for Claude's — is
   * always recoverable from disk.
   *
   * The copy is byte-exact: `readFileSync(p, "utf8")` and write back would store
   * U+FFFD wherever the file was not valid UTF-8, so the copy taken to protect
   * the user's file would itself be the corrupted version. Only an unsaved buffer
   * is written as text, because that is all it is.
   *
   * The outcome is reported rather than swallowed. `nothing-to-copy` is a normal
   * state — undoing a file Claude deleted has nothing to copy — but `failed`
   * means the confirmation dialog's promise that "a copy of each is saved first"
   * is about to be broken, and the caller must not proceed.
   */
  private snapshot(absPath: string, reason: string): SnapshotResult {
    const target = path.join(
      snapshotsDir(this.stateDir),
      `${pathKey(absPath)}-${uniqueSuffix()}`
    );
    this.markStateWrite();
    const open = this.openDocument(absPath);
    const copied = open?.isDirty ? "skip" : atomicCopy(absPath, target);
    if (copied !== "copied") {
      // Fall back to the buffer when there is one: it holds unsaved work, or the
      // content of a file that has been deleted from under an open editor. Both
      // are text by definition, so writing it out loses nothing.
      if (open) {
        if (!atomicWrite(target, open.getText())) {
          this.log(`could not write a recovery snapshot for ${absPath}`);
          return "failed";
        }
      } else if (copied === "missing") {
        return "nothing-to-copy";
      } else {
        this.log(
          `could not copy ${absPath} aside before ${reason}: proceeding without a recovery snapshot`
        );
        return "nothing-to-copy";
      }
    }
    atomicWrite(
      sidecarPath(target),
      JSON.stringify({ path: absPath, ts: Date.now(), reason }, null, 2)
    );
    this.log(`snapshot before ${reason}: ${target}`);
    return "written";
  }

  /**
   * Take the recovery copy an Undo depends on, or explain why it will not run.
   *
   * `snapshot()` used to return `undefined` on every failure and all four call
   * sites discarded it, so a full disk or an unwritable state directory destroyed
   * the file anyway — right after a dialog promising a copy had been saved.
   */
  private snapshotOrRefuse(absPath: string, reason: string): boolean {
    if (this.snapshot(absPath, reason) !== "failed") {
      return true;
    }
    this.log(
      `refusing to ${reason} ${absPath}: the recovery snapshot could not be written`
    );
    return false;
  }

  /** Drop snapshots older than the TTL, and cap how many are kept. */
  private pruneSnapshots(): void {
    const dir = snapshotsDir(this.stateDir);
    const entries = listDir(dir)
      .filter((name) => !name.endsWith(".json"))
      .map((name) => {
        const full = path.join(dir, name);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {
          /* ignore */
        }
        return { full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);

    const cutoff = Date.now() - SNAPSHOT_TTL_MS;
    entries.forEach((entry, i) => {
      if (i >= SNAPSHOT_MAX || entry.mtime < cutoff) {
        removeFile(entry.full);
        removeFile(sidecarPath(entry.full));
      }
    });
  }

  snapshotsLocation(): string {
    return snapshotsDir(this.stateDir);
  }

  /**
   * Everything needed to put a file back the way Claude left it — content,
   * baseline and creation flag — captured *before* a destructive action.
   *
   * The recovery snapshot on disk already makes an Undo reversible, but only by
   * hand: it restores the bytes and nothing knows the file is under review
   * again. This is the same guarantee made usable from a button.
   */
  captureUndoSnapshot(absPath: string): UndoSnapshot | undefined {
    const baseline =
      this.tracked.get(absPath)?.baseline ??
      readFileSafe(this.baselinePath(absPath));
    if (baseline === undefined) {
      return undefined;
    }
    const result = this.currentContentResult(absPath);
    return {
      path: absPath,
      content: result.kind === "ok" ? result.text : undefined,
      baseline,
      created: this.createdFiles.has(absPath),
    };
  }

  /**
   * Record what an Undo left on disk, so a Restore can refuse a stale one.
   *
   * Called by the command layer *after* the undo has landed, because that is the
   * only moment the post-undo state exists.
   */
  stampPostUndo(snapshots: UndoSnapshot[]): UndoSnapshot[] {
    return snapshots.map((snap) => ({
      ...snap,
      postUndo: this.currentState(snap.path),
    }));
  }

  private currentState(absPath: string): PostUndoState {
    const result = this.currentContentResult(absPath);
    const baseline = readFileSafe(this.baselinePath(absPath));
    return {
      content: result.kind === "ok" ? textDigest(result.text) : undefined,
      baseline: baseline === undefined ? undefined : textDigest(baseline),
    };
  }

  /**
   * Re-apply captured snapshots: the content Claude had produced, plus the
   * baseline that makes the file come back *awaiting review*.
   *
   * Both writes are whole-file overwrites, so both are guarded. `stale` holds the
   * paths that have moved since the Undo — the file was edited again, or Claude
   * produced a newer baseline for it — where re-applying would silently discard
   * everything done in between, and overwriting `baselines/<key>` would destroy
   * the only copy of the pre-Claude content for the *newer* edit.
   */
  async restoreUndoSnapshots(
    snapshots: UndoSnapshot[]
  ): Promise<{ failed: string[]; stale: string[] }> {
    const failed: string[] = [];
    const stale: string[] = [];
    for (const snap of snapshots) {
      if (snap.content === undefined) {
        failed.push(snap.path);
        continue;
      }
      if (this.hasMovedSinceUndo(snap)) {
        stale.push(snap.path);
        continue;
      }
      // Every other destructive write in this class copies the file aside first;
      // this one used to be the exception, which made the content it overwrote
      // the only content in the extension that was not recoverable.
      if (!this.snapshotOrRefuse(snap.path, "restore undo")) {
        failed.push(snap.path);
        continue;
      }
      // The baseline goes back first: without it the content would be restored
      // as the user's own work rather than as a change still awaiting review.
      if (!this.writeBaseline(snap.path, snap.baseline, snap.created)) {
        failed.push(snap.path);
        continue;
      }
      if (!(await this.applyContentToFile(snap.path, snap.content))) {
        failed.push(snap.path);
        continue;
      }
      this.tracked.delete(snap.path);
      this.recompute(snap.path, true);
    }
    this.fire(undefined);
    return { failed, stale };
  }

  /** Has anything happened to this path since the Undo we are undoing? */
  private hasMovedSinceUndo(snap: UndoSnapshot): boolean {
    if (!snap.postUndo) {
      return false; // captured by a caller that does not stamp: nothing to compare
    }
    const now = this.currentState(snap.path);
    return (
      now.content !== snap.postUndo.content ||
      now.baseline !== snap.postUndo.baseline
    );
  }

  // --- current content -----------------------------------------------------

  private openDocument(absPath: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(
      (d) => d.uri.scheme === "file" && d.uri.fsPath === absPath
    );
  }

  /**
   * The current content to diff against the baseline. We trust the disk (that
   * is where Claude writes its edits) and only prefer an open editor when it has
   * unsaved user changes — otherwise a stale, not-yet-synced editor buffer could
   * momentarily match the baseline and cause a spurious resolve.
   *
   * "Missing", "unreadable" and "not UTF-8" are all kept apart from "empty":
   * collapsing them made a file the user deleted, or one the process cannot open,
   * look exactly like a file Claude had emptied.
   */
  currentContentResult(absPath: string): BytesReadResult {
    const open = this.openDocument(absPath);
    if (open && open.isDirty) {
      return asTextResult(open.getText());
    }
    const result = readFileBytesResult(absPath);
    if (result.kind === "missing" && open) {
      return asTextResult(open.getText());
    }
    return result;
  }

  currentContent(absPath: string): string {
    const result = this.currentContentResult(absPath);
    return result.kind === "ok" ? result.text : "";
  }

  // --- ingestion -----------------------------------------------------------

  /**
   * Record the original content of a file the first time Claude touches it.
   * Does nothing if a baseline already exists (so we always keep the *oldest*
   * pre-Claude state across a burst of edits).
   */
  registerBaseline(
    absPath: string,
    baseline: string,
    options: { created?: boolean } = {}
  ): void {
    if (!this.isInScope(absPath)) {
      this.log(`ignoring ${absPath}: outside the workspace folder`);
      return;
    }
    if (this.isIgnored(absPath)) {
      // The last line of defence, not the first: the hook and the transcript
      // reader both check before they read the file, so reaching this point
      // means the content is already in memory. It goes no further than that.
      this.log(`ignoring ${absPath}: excluded from review`);
      return;
    }
    if (fileExists(this.baselinePath(absPath))) {
      this.recompute(absPath);
      return;
    }
    if (looksBinary(baseline)) {
      this.noteUnreviewable(
        absPath,
        "the file is not UTF-8 text, so it cannot be reviewed line by line"
      );
      this.log(`refusing to track ${absPath}: not UTF-8 text`);
      return;
    }
    if (!this.writeBaseline(absPath, baseline, options.created === true)) {
      return;
    }
    // Not unconditionally. The baseline came from disk, so anything unsaved in an
    // open buffer is the user's work and is absent from it — clearing the flag
    // here would undo the very record that keeps `recompute` from presenting
    // those lines as Claude's with no confirmation behind them.
    if (!this.openDocument(absPath)?.isDirty) {
      this.userTouched.delete(absPath);
    }
    this.clearUnreviewable(absPath);
    this.log(`baseline registered for ${absPath}`);
    this.recompute(absPath);
    this.announceDetection(absPath);
  }

  /** Re-read every known baseline from disk and recompute (used on load). */
  refreshFromDisk(): void {
    // Before the baselines, because a staging is the one piece of state nothing
    // else revisits: a Pre hook whose Post never ran leaves the file's content
    // in `pending/` with no baseline and no entry pointing at it.
    this.sweepPendingState();
    const seen = new Set<string>();
    for (const entry of this.baselinePaths()) {
      seen.add(entry.path);
      if (entry.created) {
        this.createdFiles.add(entry.path);
      } else {
        this.createdFiles.delete(entry.path);
      }
      this.tracked.delete(entry.path); // force a re-read of the baseline
      this.recompute(entry.path, /*silent*/ true);
    }
    // Drop tracked entries whose baseline disappeared from disk.
    for (const absPath of [...this.tracked.keys()]) {
      if (!seen.has(absPath)) {
        this.tracked.delete(absPath);
        this.userTouched.delete(absPath);
        this.createdFiles.delete(absPath);
        // Its baseline is gone, so an open diff tab would quietly become a
        // comparison of the file against itself.
        this.closeDiffTabs(absPath);
      }
    }
    this.fire(undefined);
  }

  /**
   * Re-read one baseline from disk and recompute just that file.
   *
   * The hook watcher used to call `refreshFromDisk()` for every event, which
   * re-diffs every tracked file: a run touching a hundred files then cost a
   * hundred full diffs per event, all on the extension host thread.
   */
  reloadBaseline(absPath: string): void {
    if (!this.shouldTrack(absPath)) {
      // The hook captured something we do not review — out of scope, or matched
      // by an ignore rule it did not have yet. Drop it here as well as in the
      // full sweep, or it sits in storage until the next one.
      this.discardState(absPath);
      return;
    }
    // Dropping the entry is what makes `recompute` re-read the baseline — and
    // its creation flag — from disk instead of reusing the copy in memory.
    this.tracked.delete(absPath);
    this.recompute(absPath);
    this.announceDetection(absPath);
  }

  /**
   * Announce a detection, but only if the file really did end up with something
   * to review — an ingestion that resolved to nothing is not news.
   */
  private announceDetection(absPath: string): void {
    if (!this.disposed && this.tracked.has(absPath)) {
      this._onDidDetect.fire(vscode.Uri.file(absPath));
    }
  }

  /**
   * Recompute hunks for one path. Resolves (untracks) the entry when there is
   * no remaining difference between baseline and current content.
   *
   * The baseline is taken from the in-memory entry when we already have one —
   * it only changes when *we* rewrite it — so typing in a tracked file no longer
   * costs a file read per keystroke.
   */
  recompute(absPath: string, silent = false, noResolve = false): void {
    const existing = this.tracked.get(absPath);
    let baseline = existing?.baseline;
    let created = existing?.created ?? false;
    if (baseline === undefined) {
      baseline = readFileSafe(this.baselinePath(absPath));
      // Reading the sidecar only on the transition into tracked keeps the
      // creation flag off the per-keystroke path.
      created = baseline === undefined ? false : this.readCreatedFlag(absPath);
      if (
        baseline !== undefined &&
        !this.baselineIsFaithful(absPath, baseline)
      ) {
        return;
      }
    }
    if (baseline === undefined) {
      // No baseline on disk: nothing to track. `userTouched` is deliberately *not*
      // cleared here — this branch runs on the debounced recompute for every
      // untracked file, so clearing it would erase the record of a user edit made
      // before Claude's within 200 ms of making it, which is the whole case the
      // record exists for. It is cleared when the file is reviewed, and bounded in
      // the meantime.
      this.createdFiles.delete(absPath);
      if (this.tracked.delete(absPath) && !silent) {
        this.fire(vscode.Uri.file(absPath));
      }
      return;
    }
    if (!this.shouldTrack(absPath)) {
      // The setting was turned off, or a rule started matching, while this file
      // was being tracked. `reconcileIgnored` handles the state on disk; this is
      // only the in-memory entry, which a stray recompute must not resurrect.
      if (this.tracked.delete(absPath)) {
        this.closeDiffTabs(absPath);
        if (!silent) {
          this.fire(vscode.Uri.file(absPath));
        }
      }
      return;
    }

    const result = this.currentContentResult(absPath);
    if (result.kind === "error") {
      // Unreadable is not empty. Leave the entry as it was rather than reporting
      // that Claude deleted the whole file.
      this.log(`cannot read ${absPath} (${result.message}); leaving it as is`);
      return;
    }
    if (result.kind === "binary") {
      // Not round-trippable UTF-8: every write-back would replace its bytes with
      // U+FFFD. Stop reviewing it, but leave the baseline on disk — it is the only
      // copy of the pre-Claude content and deleting it is not a fix for this.
      this.demote(
        absPath,
        "the file is not UTF-8 text, so it cannot be reviewed line by line",
        silent
      );
      return;
    }
    const missing = result.kind === "missing";
    const current = missing ? "" : result.text;

    // Nothing changed since the hunks were computed. `recompute` runs on a
    // debounced keystroke, on every save, and on every detection event, so the
    // no-op case is the common one — and skipping it here avoids splitting the
    // file into one string per line and running a Myers search over it.
    const digest = textDigest(current);
    if (
      existing &&
      existing.digest === digest &&
      existing.missing === missing
    ) {
      return;
    }

    let hunks = computeHunks(baseline, current);
    if (hunks.length === 0 && current !== baseline) {
      // Same lines, different bytes — an EOL-only rewrite, which is what Claude's
      // Write tool ordinarily does to a CRLF file. `resolve()` below would accept
      // it and delete the baseline, and the original terminators would be
      // unrecoverable. Keep it reviewable instead.
      hunks = [eolOnlyHunk(baseline, current)];
    }
    if (hunks.length === 0) {
      if (noResolve) {
        // Reached from a *failed* Keep/Undo. Resolving here would delete the
        // baseline — the only copy of the pre-Claude content — on the strength of
        // a write that did not happen.
        this.log(
          `not resolving ${absPath}: the action that produced this state failed`
        );
        return;
      }
      if (existing && this.onlyTheBufferMatches(absPath, baseline)) {
        // An unsaved buffer is not proof the change was reviewed: on disk the
        // file still holds Claude's content, and deleting the baseline now would
        // leave nothing to undo it with. The last line of defence for an Undo
        // whose save failed *and* whose editor rollback failed too — after which
        // the debounced recompute would otherwise resolve the entry away.
        //
        // Only for a file already tracked: Keep rewrites the baseline and drops
        // the entry before recomputing, and accepting the buffer is exactly what
        // it asked for.
        this.log(
          `not resolving ${absPath}: only the unsaved buffer matches the baseline`
        );
        return;
      }
      this.resolve(absPath, silent);
      return;
    }
    this.tracked.set(absPath, {
      path: absPath,
      baseline,
      hunks,
      userTouched: this.userTouched.has(absPath),
      missing,
      degraded: hunks.some((h) => h.degraded === true),
      created,
      digest,
    });
    // Both directions: a baseline replaced on disk by one without the flag must
    // clear it, or Undo would go on believing it has a file to delete.
    if (created) {
      this.createdFiles.add(absPath);
    } else {
      this.createdFiles.delete(absPath);
    }
    if (!silent) {
      this.fire(vscode.Uri.file(absPath));
    }
  }

  /**
   * Is the stored baseline a faithful copy of what its producer captured?
   *
   * Everything here is stored as UTF-8 text, so a producer that decoded a
   * non-UTF-8 file lossily hands over a string with a three-byte U+FFFD wherever
   * a bad byte was. Its length gives it away: the sidecar records the source's
   * byte count at capture time, and a mismatch means writing this baseline back
   * on Undo would corrupt the file. That catches any density of bad bytes, which
   * `looksBinary` — a density test on already-decoded text — cannot: a
   * windows-1252 source with three accented characters in five thousand passes it
   * and then loses one character per accent on Undo.
   *
   * Records written before 1.1.1 have no byte count; they fall back to the
   * heuristic, which is all there ever was for them.
   */
  private baselineIsFaithful(absPath: string, baseline: string): boolean {
    const sidecar = readSidecar(this.baselinePath(absPath));
    const expected = sidecar?.bytes;
    if (expected === undefined) {
      if (!looksBinary(baseline)) {
        return true;
      }
      this.demote(
        absPath,
        "the recorded original is not UTF-8 text, so restoring it would corrupt the file"
      );
      return false;
    }
    if (Buffer.byteLength(baseline, "utf8") === expected) {
      return true;
    }
    this.log(
      `baseline for ${absPath} is ${Buffer.byteLength(baseline, "utf8")} bytes but ${expected} were captured: not a byte-exact copy`
    );
    this.demote(
      absPath,
      "the recorded original is not a byte-exact copy of the file, so restoring it would corrupt it"
    );
    return false;
  }

  /**
   * Is the baseline matched only by an unsaved buffer, while the file on disk
   * still differs? Then nothing has been reviewed yet.
   */
  private onlyTheBufferMatches(absPath: string, baseline: string): boolean {
    const open = this.openDocument(absPath);
    if (!open?.isDirty) {
      return false;
    }
    const onDisk = readFileBytesResult(absPath);
    if (onDisk.kind === "missing") {
      return baseline !== "";
    }
    return onDisk.kind !== "ok" || onDisk.text !== baseline;
  }

  /**
   * Stop reviewing a path and say why, *without* deleting its baseline.
   *
   * Unlike `resolve`, which is the terminal state of a completed review, this is
   * for a file we cannot review safely. Its baseline is still the only copy of the
   * pre-Claude content, so it stays on disk.
   */
  private demote(absPath: string, reason: string, silent = false): void {
    this.log(`untracking ${absPath}: ${reason}`);
    this.noteUnreviewable(absPath, reason);
    const wasTracked = this.tracked.delete(absPath);
    if (wasTracked) {
      this.closeDiffTabs(absPath);
      if (!silent) {
        this.fire(vscode.Uri.file(absPath));
      }
    }
  }

  /** Mark a path fully reviewed: delete its state and stop tracking it. */
  private resolve(absPath: string, silent = false): void {
    this.markStateWrite();
    const baseline = this.baselinePath(absPath);
    removeFile(baseline);
    removeFile(sidecarPath(baseline));
    // A staged pre-edit copy left behind by a Pre hook whose Post never ran
    // would otherwise be promoted as the baseline for a much later edit.
    const pending = this.pendingPath(absPath);
    removeFile(pending);
    removeFile(sidecarPath(pending));

    this.tracked.delete(absPath);
    this.userTouched.delete(absPath);
    this.createdFiles.delete(absPath);
    this.closeDiffTabs(absPath);
    if (!silent) {
      this.fire(vscode.Uri.file(absPath));
    }
  }

  /**
   * Forget a path we are not reviewing after all, and everything recorded about
   * it. Same disk work as {@link resolve} — the pre-Claude content is a copy of
   * a file the user asked us not to hold, so it does not survive as "recovery
   * data" the way a demoted baseline does.
   */
  private discardState(absPath: string): void {
    if (this.hasBaseline(absPath)) {
      this.log(`discarding recorded state for ${absPath}: not under review`);
    }
    this.resolve(absPath, true);
  }

  /**
   * Bring the queue and the state directory into line with the ignore rules,
   * and report which files left the queue because of them.
   *
   * A file that becomes ignored while it has changes waiting is dropped, and its
   * baseline with it — so those changes are, in effect, kept. That is the honest
   * reading of "stop looking at this file", but it is not something to do
   * silently: the returned paths are what the caller names in the notification,
   * and the command that adds a rule confirms first.
   *
   * The reverse does not restore anything. Once the recorded original is gone
   * there is nothing to review against; the next edit Claude makes to the file
   * starts it over.
   */
  reconcileIgnored(): string[] {
    const left = [...this.tracked.keys()].filter((p) => this.isIgnored(p));
    for (const absPath of left) {
      this.log(`${absPath} is now ignored: leaving the review queue`);
      this.resolve(absPath, true);
    }
    for (const absPath of [...this.unreviewable.keys()]) {
      if (this.isIgnored(absPath)) {
        this.unreviewable.delete(absPath);
      }
    }
    // Re-reads every baseline through the new rules — which is what drops the
    // ones belonging to files that are now ignored — sweeps the stagings, and
    // fires once at the end.
    this.refreshFromDisk();
    return left;
  }

  /**
   * Drop pre-edit copies staged by the hook for files we are not reviewing.
   *
   * `baselinePaths()` sweeps `baselines/`, and `resolve()` clears the staging of
   * one path. Neither reaches a staging whose Post hook never ran: that file has
   * no baseline and no tracked entry, so nothing else would ever look at it
   * again until the TTL, and until then it holds the verbatim content of a file
   * the user excluded.
   */
  private sweepPendingState(): void {
    const dir = pendingDir(this.stateDir);
    for (const name of listDir(dir)) {
      if (name.endsWith(".json") || name.endsWith(".tmp")) {
        continue;
      }
      const contentPath = path.join(dir, name);
      const sidecar = readSidecar(contentPath);
      if (!sidecar || this.shouldTrack(sidecar.path)) {
        continue;
      }
      this.markStateWrite();
      this.log(`dropping the staged copy of ${sidecar.path}: not under review`);
      removeFile(contentPath);
      removeFile(sidecarPath(contentPath));
    }
  }

  /**
   * Close our own diff tabs for a resolved file. The baseline provider serves
   * the live content once the baseline is gone, so an open tab would otherwise
   * quietly turn into an empty diff instead of going away.
   */
  private closeDiffTabs(absPath: string): void {
    const stale: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (
          input instanceof vscode.TabInputTextDiff &&
          input.original.scheme === BASELINE_SCHEME &&
          input.modified.scheme === "file" &&
          input.modified.fsPath === absPath
        ) {
          stale.push(tab);
        }
      }
    }
    if (stale.length > 0) {
      void vscode.window.tabGroups.close(stale, true);
    }
  }

  // --- actions -------------------------------------------------------------

  /**
   * The live content of a tracked file, or undefined when the file has moved on
   * from the revision its hunks were computed against.
   *
   * Every per-hunk action needs this, because a hunk's coordinates only mean
   * anything for one revision and the content checks inside
   * `keepHunkInBaseline`/`undoHunkInCurrent` cannot enforce that: for a pure
   * deletion the current-side check has an empty expectation and so matches
   * anywhere, and the baseline-side check runs against a string the store only
   * ever replaces wholesale. A file rewritten under the store — `git checkout`, a
   * `prettier --write` from a terminal, a keystroke inside the recompute debounce
   * — therefore had restored lines spliced in at a position that no longer had
   * that meaning, and the action reported success. The digest is already
   * recorded, so checking it costs one allocation-free pass.
   */
  private contentAtHunkRevision(
    absPath: string,
    t: TrackedFile
  ): string | undefined {
    const current = this.currentContent(absPath);
    if (textDigest(current) !== t.digest) {
      this.log(`${absPath} has changed since its hunks were computed`);
      this.recompute(absPath);
      return undefined;
    }
    return current;
  }

  keepHunk(absPath: string, index: number, fingerprint?: string): ApplyResult {
    const t = this.tracked.get(absPath);
    if (!t) {
      return "unavailable";
    }
    const current = this.contentAtHunkRevision(absPath, t);
    if (current === undefined) {
      return "stale";
    }
    const hunk = t.hunks[index];
    if (
      !hunk ||
      (fingerprint !== undefined && hunk.fingerprint !== fingerprint)
    ) {
      this.recompute(absPath);
      return "stale";
    }
    const next = keepHunkInBaseline(t.baseline, current, hunk);
    if (next === undefined) {
      this.recompute(absPath);
      return "stale";
    }
    if (!this.writeBaseline(absPath, next)) {
      return "failed";
    }
    this.tracked.delete(absPath); // the baseline changed: re-read it
    this.recompute(absPath);
    return "applied";
  }

  async undoHunk(
    absPath: string,
    index: number,
    fingerprint?: string
  ): Promise<ApplyResult> {
    const t = this.tracked.get(absPath);
    if (!t) {
      return "unavailable";
    }
    const current = this.contentAtHunkRevision(absPath, t);
    if (current === undefined) {
      return "stale";
    }
    const hunk = t.hunks[index];
    if (
      !hunk ||
      (fingerprint !== undefined && hunk.fingerprint !== fingerprint)
    ) {
      this.recompute(absPath);
      return "stale";
    }
    const next = undoHunkInCurrent(current, t.baseline, hunk);
    if (next === undefined) {
      this.recompute(absPath);
      return "stale";
    }
    if (!this.snapshotOrRefuse(absPath, "undo hunk")) {
      return "failed";
    }
    const ok = await this.restore(absPath, next, t.created);
    this.recompute(absPath, false, /*noResolve*/ !ok);
    return ok ? "applied" : "failed";
  }

  /**
   * Keep a change described by VS Code's quick diff widget. Resolving the change
   * from its own line coordinates — instead of from a hunk index captured when
   * the UI was rendered — means the action always applies to what the user is
   * actually looking at.
   */
  /**
   * Resolve a quick-diff widget change against the hunks the store holds.
   *
   * `lineChangeToHunk` derives the hunk's lines by slicing the texts it is
   * handed, so everything downstream compares a slice with itself and cannot
   * fail — the widget's own coordinates are taken entirely on trust. They come
   * from VS Code's editor model as of whenever it last diffed, which is not
   * necessarily the revision on disk, and acting on stale ones deletes the user's
   * lines and duplicates Claude's.
   *
   * Requiring the derived region to sit inside a difference the store actually
   * computed is the check that was missing. The derived hunk is then what gets
   * applied, not the store's: it is the narrower of the two and it is the one the
   * user clicked on.
   */
  private hunkForLineChange(
    t: TrackedFile,
    change: LineChange,
    current: string
  ): Hunk | undefined {
    const derived = lineChangeToHunk(change, t.baseline, current);
    if (!derived) {
      return undefined;
    }
    return t.hunks.some((h) => hunkCovers(h, derived)) ? derived : undefined;
  }

  keepLineChange(absPath: string, change: LineChange): ApplyResult {
    const t = this.tracked.get(absPath);
    if (!t) {
      return "unavailable";
    }
    const current = this.contentAtHunkRevision(absPath, t);
    if (current === undefined) {
      return "stale";
    }
    const hunk = this.hunkForLineChange(t, change, current);
    if (!hunk) {
      this.recompute(absPath);
      return "stale";
    }
    const next = keepHunkInBaseline(t.baseline, current, hunk);
    if (next === undefined) {
      this.recompute(absPath);
      return "stale";
    }
    if (!this.writeBaseline(absPath, next)) {
      return "failed";
    }
    this.tracked.delete(absPath);
    this.recompute(absPath);
    return "applied";
  }

  /** Undo a change described by VS Code's quick diff widget. */
  async undoLineChange(
    absPath: string,
    change: LineChange
  ): Promise<ApplyResult> {
    const t = this.tracked.get(absPath);
    if (!t) {
      return "unavailable";
    }
    const current = this.contentAtHunkRevision(absPath, t);
    if (current === undefined) {
      return "stale";
    }
    const hunk = this.hunkForLineChange(t, change, current);
    if (!hunk) {
      this.recompute(absPath);
      return "stale";
    }
    const next = undoHunkInCurrent(current, t.baseline, hunk);
    if (next === undefined) {
      this.recompute(absPath);
      return "stale";
    }
    if (!this.snapshotOrRefuse(absPath, "undo change")) {
      return "failed";
    }
    const ok = await this.restore(absPath, next, t.created);
    this.recompute(absPath, false, /*noResolve*/ !ok);
    return ok ? "applied" : "failed";
  }

  /** Keep every change in the file: accept current content as the new truth. */
  keepFile(absPath: string): void {
    this.resolve(absPath);
  }

  /** Undo every change in the file: restore the recorded baseline. */
  async undoFile(absPath: string): Promise<ApplyResult> {
    const baseline =
      this.tracked.get(absPath)?.baseline ??
      readFileSafe(this.baselinePath(absPath));
    if (baseline === undefined) {
      return "unavailable";
    }
    // Same condition `restore` applies, so the two can never disagree about
    // whether the file was removed or rewritten.
    const deletes = this.wouldDelete(absPath);
    if (!this.snapshotOrRefuse(absPath, "undo file")) {
      return "failed";
    }
    const ok = await this.restore(absPath, baseline, deletes);
    if (!ok) {
      this.recompute(absPath, false, /*noResolve*/ true);
      return "failed";
    }
    if (deletes) {
      // The file is gone; there is no content to compare against a baseline.
      this.resolve(absPath);
      return "applied";
    }
    return this.resolveIfRestored(absPath, baseline);
  }

  keepAll(): void {
    for (const absPath of [...this.tracked.keys()]) {
      this.resolve(absPath, true);
    }
    this.fire(undefined);
  }

  /** Undo everything currently pending. */
  async undoAll(): Promise<UndoBatchResult> {
    return this.undoPaths([...this.tracked.keys()]);
  }

  /**
   * Undo an explicit set of paths.
   *
   * The set has to come from the caller. `undoAll` used to re-derive it from the
   * live `tracked` map at the moment it ran, which is *after* the confirmation
   * modal — and the hook and transcript watchers keep registering baselines while
   * a modal is up. Everything that appeared in that window was reverted without
   * being named in the confirmation, without a recovery snapshot the Restore
   * button could use, and — for a file Claude had created — deleted with no
   * deletion warning at all.
   */
  async undoPaths(paths: string[]): Promise<UndoBatchResult> {
    const failed: string[] = [];
    const reformatted: string[] = [];
    const deleted: string[] = [];
    const skipped: string[] = [];
    let applied = 0;
    for (const absPath of paths) {
      if (!this.tracked.has(absPath)) {
        // Resolved by something else between the confirmation and here.
        skipped.push(absPath);
        continue;
      }
      const baseline =
        this.tracked.get(absPath)?.baseline ??
        readFileSafe(this.baselinePath(absPath));
      if (baseline === undefined) {
        this.resolve(absPath, true);
        skipped.push(absPath);
        continue;
      }
      const deletes = this.wouldDelete(absPath);
      if (!this.snapshotOrRefuse(absPath, "undo all")) {
        failed.push(absPath);
        continue;
      }
      if (!(await this.restore(absPath, baseline, deletes))) {
        failed.push(absPath);
        this.recompute(absPath, true, /*noResolve*/ true);
        continue;
      }
      if (deletes) {
        deleted.push(absPath);
        this.resolve(absPath, true);
        applied++;
        continue;
      }
      const outcome = this.resolveIfRestored(absPath, baseline, true);
      if (outcome === "applied") {
        applied++;
      } else if (outcome === "applied-modified") {
        // Written, then reformatted by a save participant. A success that is
        // still under review — not a failure, and reporting it as one is what
        // disarmed the Restore point for a whole batch in any workspace with
        // format-on-save.
        reformatted.push(absPath);
      } else {
        failed.push(absPath);
      }
    }
    this.fire(undefined);
    return { applied, reformatted, failed, deleted, skipped };
  }

  /**
   * Finish an Undo only if the file really came back to the baseline.
   *
   * Saving runs the editor's save participants — format-on-save, organise
   * imports, trailing-whitespace trimming — which can rewrite the content we
   * just restored. Resolving unconditionally would delete the baseline and
   * silently accept whatever they produced.
   */
  private resolveIfRestored(
    absPath: string,
    baseline: string,
    silent = false
  ): ApplyResult {
    const result = this.currentContentResult(absPath);
    if (result.kind === "error" || result.kind === "binary") {
      // Unreadable is not "restored". `recompute` refuses to act on this exact
      // condition thirteen lines away, and it is right: resolving would delete the
      // baseline — the only recovery data — on no evidence at all.
      this.log(
        `cannot verify ${absPath} after Undo (${result.kind === "error" ? result.message : "not UTF-8 text"}); keeping it under review`
      );
      return "failed";
    }
    const settled = result.kind === "ok" ? result.text : undefined;
    if (settled === baseline || settled === undefined) {
      this.resolve(absPath, silent);
      return "applied";
    }
    this.log(
      `${absPath} did not settle back to the baseline after saving (a save participant changed it); keeping it under review`
    );
    this.tracked.delete(absPath);
    this.recompute(absPath, silent);
    return "applied-modified";
  }

  /**
   * Put a file back to `text` — or remove it, when `text` is the empty baseline
   * of a file Claude created.
   *
   * Writing an empty file there would be the wrong answer to "undo this": the
   * state being restored is *the file not existing*. An empty file survives,
   * opens, and shows up in `git status` as an addition the user believes they
   * reverted.
   */
  private async restore(
    absPath: string,
    text: string,
    created: boolean
  ): Promise<boolean> {
    if (created && text === "") {
      return this.deleteCreatedFile(absPath);
    }
    return this.applyContentToFile(absPath, text);
  }

  /**
   * Would undoing this file delete it rather than rewrite it?
   *
   * Deliberately re-derived from the baseline rather than trusting `created`
   * alone. The flag is set far away and long before it is used — by a hook that
   * cannot always tell "no such file" from "could not read it", or by a write
   * snapshot taken against a transcript — and the cost of it being wrong is the
   * removal of a file that was never Claude's to remove. A deletion therefore
   * requires *both* the recorded intent and a baseline that is genuinely empty.
   */
  wouldDelete(absPath: string): boolean {
    if (!this.createdFiles.has(absPath)) {
      return false;
    }
    const baseline =
      this.tracked.get(absPath)?.baseline ??
      readFileSafe(this.baselinePath(absPath));
    return baseline === "";
  }

  /**
   * Delete a file Claude created, through a `WorkspaceEdit` so the deletion goes
   * on the editor's undo stack exactly like every other destructive action here.
   * A recovery snapshot has already been taken by the caller.
   */
  private async deleteCreatedFile(absPath: string): Promise<boolean> {
    const uri = vscode.Uri.file(absPath);
    this.applying++;
    try {
      const edit = new vscode.WorkspaceEdit();
      edit.deleteFile(uri, { ignoreIfNotExists: true });
      if (await vscode.workspace.applyEdit(edit)) {
        this.log(`deleted ${absPath} (created by Claude)`);
        return true;
      }
      // A file nobody had open may not be reachable through the edit API on
      // every remote/virtual filesystem; fall back to the direct removal.
      removeFile(absPath);
      return !fileExists(absPath);
    } catch (err) {
      this.log(`failed to delete ${absPath}: ${String(err)}`);
      return false;
    } finally {
      this.applying--;
    }
  }

  /**
   * Write text to a file through its text document whenever possible.
   *
   * Going through a `WorkspaceEdit` rather than straight to disk puts every
   * destructive action on the editor's own undo stack, so a Ctrl+Z brings the
   * user's work back even when the store guessed wrong about whose changes
   * these were. Very large files that nobody had open are written directly:
   * opening them would wake language servers for no benefit.
   */
  private async applyContentToFile(
    absPath: string,
    text: string
  ): Promise<boolean> {
    const uri = vscode.Uri.file(absPath);
    this.applying++;
    try {
      let doc = this.openDocument(absPath);
      if (
        !doc &&
        Buffer.byteLength(text, "utf8") <= OPEN_DOCUMENT_LIMIT_BYTES
      ) {
        try {
          doc = await vscode.workspace.openTextDocument(uri);
        } catch {
          doc = undefined;
        }
      }
      if (doc && !representableIn(text, doc.eol)) {
        // A text model normalizes every terminator to the document's own EOL, so
        // this content cannot survive the editor route: it would be written with
        // the wrong line endings and reported as restored. That happens for the
        // baseline of any file Claude rewrote from CRLF to LF — its Write tool
        // emits LF — and for every mixed-EOL file. The editor undo stack is worth
        // having, but not at the price of writing something other than the
        // baseline, so this one goes straight to disk.
        this.log(
          `writing ${absPath} directly: its line endings do not match the open document`
        );
        doc = undefined;
      }
      if (doc) {
        // Captured before the edit so a failed save can be undone. `applyEdit`
        // changes the buffer and `save()` can still fail — a read-only file, a
        // save conflict, a settings.json with a syntax error — and the buffer was
        // then left dirty holding the restored content. Every caller reacts to the
        // failure with a recompute, which prefers a dirty buffer over disk, sees
        // baseline === current, and resolves: the baseline is deleted while
        // Claude's changes are still on disk, and the user is told the Undo failed.
        const before = doc.getText();
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, fullRangeOf(doc), text);
        if (!(await vscode.workspace.applyEdit(edit))) {
          return false;
        }
        if (!doc.isDirty) {
          // The edit was a no-op: the buffer already held `text`. `save()` reports
          // false for a clean document, which is not a failure.
          return doc.getText() === text;
        }
        if (await doc.save()) {
          return true;
        }
        this.log(`could not save ${absPath}; rolling the editor back`);
        try {
          const rollback = new vscode.WorkspaceEdit();
          rollback.replace(uri, fullRangeOf(doc), before);
          await vscode.workspace.applyEdit(rollback);
        } catch (err) {
          this.log(`could not roll ${absPath} back: ${String(err)}`);
        }
        return false;
      }
      ensureDir(path.dirname(absPath));
      fs.writeFileSync(absPath, text);
      return true;
    } catch (err) {
      this.log(`failed to write ${absPath}: ${String(err)}`);
      return false;
    } finally {
      this.applying--;
    }
  }
}

function fullRangeOf(doc: vscode.TextDocument): vscode.Range {
  return new vscode.Range(
    new vscode.Position(0, 0),
    doc.lineAt(doc.lineCount - 1).range.end
  );
}

/**
 * Whether a text can be held by a document byte for byte.
 *
 * A `TextDocument` has one end-of-line for the whole buffer and rewrites every
 * terminator to it, so anything with a different — or a mixed — style comes back
 * out changed.
 */
function representableIn(text: string, eol: vscode.EndOfLine): boolean {
  return eol === vscode.EndOfLine.CRLF
    ? !/(?<!\r)\n/.test(text)
    : !text.includes("\r\n");
}

function asTextResult(text: string): BytesReadResult {
  return { kind: "ok", text, bytes: Buffer.byteLength(text, "utf8") };
}
