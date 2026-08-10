import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ChangeStore } from "../changeStore";
import { claudeProjectsDir, readFileBytesResult, sessionDirFor } from "../util";
import { EditEvent, reconstructBaseline } from "./reconstruct";
import {
  editEventFor,
  filePathOf,
  parseTranscriptLine,
  trustWriteSnapshot,
  WriteSnapshotFacts,
} from "./transcriptEvents";
import { TranscriptOffsets } from "./transcriptOffsets";

/**
 * What the file looked like the moment we first saw a `Write` announced for it.
 *
 * A `Write` replaces the whole file, so the transcript records nothing about the
 * previous content. The tool call appears in the transcript before the tool
 * runs, though, so reading the file right then *can* capture the pre-write
 * state — but only if we got there first, and nothing about the parse being late
 * is visible in the content itself.
 */
type WriteSnapshot = WriteSnapshotFacts;

/**
 * A tool call seen in the transcript but not yet known to have done anything.
 *
 * The tool_use block is written *before* the tool runs, so on its own it proves
 * nothing: Claude Code refuses edits whose `old_string` is not found, the user
 * can deny the permission prompt, and transcripts on disk are not append-only —
 * the same record physically appears twice in real files. Reverse-applying an
 * edit that never happened fabricates a baseline that passes forward
 * verification (the phantom edit replays forward too, so it cancels out) and the
 * extension then presents it as fact.
 */
interface PendingUse {
  path: string;
  event: EditEvent;
  ts: number;
}

/**
 * How long to wait for a tool_result before giving up on a tool call.
 *
 * A result normally lands within milliseconds. When one never arrives — the
 * session was killed mid-turn, the transcript was rotated — the file must not be
 * pinned forever, and it must not be registered from the events that *did*
 * commit either: a baseline reconstructed from a subset of a file's edits is the
 * same corruption as one reconstructed from a phantom edit.
 */
const PENDING_RESULT_TTL_MS = 15_000;

/** Upper bound on the de-duplication set, which would otherwise grow forever. */
const SEEN_IDS_MAX = 4096;

/**
 * What a register attempt did, so the caller knows whether it may clean up.
 *
 * `unreviewable` in particular must not be followed by a cleanup: `forget` clears
 * the store's unreviewable note, and the point of that note is that the file stays
 * listed with an explanation rather than silently disappearing.
 */
type RegisterOutcome = "registered" | "unreviewable" | "nothing";

/**
 * How long a captured write snapshot stays usable.
 *
 * A snapshot that outlives its tool call is worse than none at all. `Write`
 * creating a file records `content: undefined`; if that entry survives until
 * Claude writes the *same path* again — now a real file, holding content the
 * user may have explicitly kept — it is read as "Claude created this", and Undo
 * deletes a file that genuinely existed. Same shape as the staging TTL in the
 * hook, and for the same reason.
 */
const WRITE_SNAPSHOT_TTL_MS = 60_000;

/** How much of a transcript to read in one go. */
const READ_CHUNK_BYTES = 1024 * 1024;

/**
 * How many chunks one tick may drain.
 *
 * A bound is needed because the read and the parse are synchronous on the
 * extension-host thread; without one, attaching to a large backlog would freeze
 * the UI. The remainder is not lost, only deferred: a tick that consumed
 * anything keeps the poll at its minimum interval, so the backlog drains over
 * the next few ticks instead of over the next few minutes.
 */
const MAX_CHUNKS_PER_TICK = 16;

/** How long the transcript must be quiet before we reconstruct a baseline. */
const SETTLE_MS = 600;
/** Poll interval while Claude is active, and the ceiling it backs off to. */
const POLL_MIN_MS = 1500;
const POLL_MAX_MS = 30_000;

/**
 * Zero-config fallback detector. Tails the Claude Code session transcripts under
 * ~/.claude/projects/<encoded-cwd>/, extracts Edit/Write/MultiEdit tool calls,
 * and reconstructs each file's pre-Claude baseline.
 *
 * When the hooks are installed they win: ChangeStore.registerBaseline is a no-op
 * if a baseline already exists, so this only fills the gaps.
 */
export class TranscriptWatcher implements vscode.Disposable {
  private dirWatcher: fs.FSWatcher | undefined;
  private parentWatcher: fs.FSWatcher | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  /** Per transcript file, how many bytes we have already consumed. */
  private readonly offsets = new TranscriptOffsets();
  private readonly perFileEdits = new Map<string, EditEvent[]>();
  private readonly writeSnapshots = new Map<string, WriteSnapshot>();
  private readonly registerTimers = new Map<string, NodeJS.Timeout>();
  /** tool_use blocks awaiting their tool_result, by tool_use id. */
  private readonly pendingUse = new Map<string, PendingUse>();
  /** tool_use ids already committed or rejected, so a repeated record is inert. */
  private readonly seenUseIds = new Set<string>();
  /**
   * Results whose tool_use has not been parsed yet, by id.
   *
   * Transcripts are not in timestamp order — one file on this machine has 46
   * lines out of order — so a result can be read before the call it belongs to.
   * Without this the call would sit unconfirmed until its TTL and the file would
   * be reported unreviewable for no reason.
   */
  private readonly earlyResults = new Map<string, boolean>();
  /**
   * Transcripts whose next read may begin part-way through a line.
   *
   * Every offset this class derives itself is exact, but the two that come from
   * outside are not: attaching at a file's end and re-attaching after a
   * truncation both sample a raw `stat().size` at an arbitrary instant, which can
   * land inside a line — or inside a multi-byte character, whose orphan
   * continuation bytes then decode to U+FFFD. Skipping an oversized line leaves
   * the offset mid-line by construction too. In all three cases the bytes up to
   * the next newline are a fragment, and a fragment must be discarded rather than
   * handed to the parser.
   */
  private readonly unaligned = new Set<string>();
  private lastActivityAt = 0;
  /** Last time any transcript bytes were consumed, for the poll backoff. */
  private lastConsumedAt = 0;
  private pollDelay = POLL_MIN_MS;
  private warned = false;
  private disposed = false;
  /** Set while we are the one driving the store, so its events do not recurse. */
  private inStoreWork = false;
  private unknownUseSequence = 0;
  private storeListener: vscode.Disposable;

  constructor(
    private readonly cwd: string,
    private readonly store: ChangeStore,
    private readonly log: (msg: string) => void
  ) {
    // Forget a file's history once it has been fully reviewed, so a later edit
    // reconstructs a fresh baseline instead of reversing already-resolved ops.
    //
    // The `undefined` branch is not optional. Keep All, Undo All and a disk
    // refresh all resolve every path and then fire once with no uri, so without
    // it a bulk action leaves every write snapshot behind — and a stale
    // "the file did not exist" snapshot is what turns a later Undo into the
    // deletion of a file the user had just chosen to keep.
    this.storeListener = store.onDidChange((uri) =>
      this.handleStoreChange(uri)
    );
  }

  /**
   * Drop a file's accumulated history when the store says it is *resolved* —
   * never merely because it has no baseline yet.
   *
   * Those two states are indistinguishable from the outside (`hasBaseline` is a
   * file-existence check), and conflating them loses data: half a dozen store
   * paths fire with no uri, several of them during a Claude burst, and a file
   * whose reconstruction is still scheduled has no baseline yet by definition.
   * Forgetting it there discards the earlier edits *and* cancels the pending
   * timer, so the next edit reconstructs from a partial list — and a partial
   * reconstruction verifies happily, registering Claude's own output as the
   * user's original.
   */
  private handleStoreChange(uri: vscode.Uri | undefined): void {
    if (this.inStoreWork) {
      return;
    }
    this.inStoreWork = true;
    try {
      if (uri) {
        this.forgetIfResolved(uri.fsPath);
        return;
      }
      for (const fsPath of [
        ...new Set([
          ...this.perFileEdits.keys(),
          ...this.writeSnapshots.keys(),
        ]),
      ]) {
        this.forgetIfResolved(fsPath);
      }
    } finally {
      this.inStoreWork = false;
    }
  }

  private forgetIfResolved(fsPath: string): void {
    if (this.registerTimers.has(fsPath)) {
      return; // its reconstruction has been scheduled but has not run yet
    }
    if (this.hasPendingUse(fsPath)) {
      return; // a tool call for it is still waiting for its result
    }
    if (this.store.hasBaseline(fsPath)) {
      return;
    }
    this.forget(fsPath);
  }

  private hasPendingUse(fsPath: string): boolean {
    for (const pending of this.pendingUse.values()) {
      if (pending.path === fsPath) {
        return true;
      }
    }
    return false;
  }

  start(): void {
    this.tick();
    this.scheduleTick();
  }

  /**
   * fs.watch on the projects dir is best-effort, so a poll backs it up — but it
   * backs off to every 30 s when nothing is happening. A window left open on a
   * project where Claude is not running used to cost a directory scan plus one
   * stat per session file, every 1.5 seconds, forever.
   */
  private scheduleTick(): void {
    if (this.disposed) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      // Back off on *transcript* silence, not on edit silence. Keying this to
      // parsed edit tool calls left the poll sitting at 30 s throughout a session
      // that was writing to the transcript continuously, which is what makes a
      // `Write` snapshot get taken after the write has already landed.
      const before = this.lastConsumedAt;
      this.tick();
      this.pollDelay =
        this.lastConsumedAt !== before
          ? POLL_MIN_MS
          : Math.min(this.pollDelay * 2, POLL_MAX_MS);
      this.scheduleTick();
    }, this.pollDelay);
  }

  private forget(fsPath: string): void {
    this.perFileEdits.delete(fsPath);
    this.writeSnapshots.delete(fsPath);
    for (const [id, pending] of [...this.pendingUse]) {
      if (pending.path === fsPath) {
        this.pendingUse.delete(id);
      }
    }
    this.store.clearUnreviewable(fsPath);
    const timer = this.registerTimers.get(fsPath);
    if (timer) {
      clearTimeout(timer);
      this.registerTimers.delete(fsPath);
    }
  }

  private tick(): void {
    if (this.disposed) {
      return;
    }
    const dir = sessionDirFor(this.cwd);
    let entries: string[] = [];
    try {
      entries = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => path.join(dir, f));
    } catch {
      // The session directory does not exist yet. This still counts as a sweep:
      // see TranscriptOffsets. Marking it is what makes the transcript of a
      // session started *after* us get read in full instead of skipped.
      this.offsets.sync([], sizeOf);
      // Watch the parent for the directory being created, so a first-ever
      // session in this project is picked up immediately rather than whenever the
      // backed-off poll next happens to look.
      this.ensureParentWatcher();
      return;
    }

    // Attach at each existing file's end (history) or at 0 (a session that began
    // after we did). An empty sweep still establishes the boundary.
    const fresh = entries.filter((f) => !this.offsets.has(f));
    this.offsets.sync(entries, sizeOf);
    for (const file of fresh) {
      // Attached at a byte size, which can fall anywhere — including inside a
      // character. Only offset 0 is a guaranteed line boundary.
      if (this.offsets.get(file) > 0) {
        this.unaligned.add(file);
      }
    }
    if (entries.length === 0) {
      return;
    }
    this.ensureDirWatcher(dir);

    // Consume every transcript that grew, not just the most recently touched
    // one — parallel sessions and subagents write to their own files.
    for (const file of entries) {
      this.consume(file);
    }
  }

  private ensureDirWatcher(dir: string): void {
    if (this.dirWatcher) {
      return;
    }
    try {
      this.dirWatcher = fs.watch(dir, () => this.tick());
    } catch {
      /* rely on the poll */
    }
  }

  /** Watch ~/.claude/projects for our session directory appearing. */
  private ensureParentWatcher(): void {
    if (this.parentWatcher || this.dirWatcher) {
      return;
    }
    try {
      this.parentWatcher = fs.watch(claudeProjectsDir(), () => this.tick());
    } catch {
      /* rely on the poll */
    }
  }

  /**
   * Read newly appended bytes from one transcript and parse them.
   *
   * Drains in bounded chunks rather than one per tick. A transcript can outgrow
   * the chunk size in a single turn (a large `Read` result, an image block), and
   * advancing one chunk per tick means the backlog is consumed at the *poll*
   * rate — which backs off to 30 s precisely when nothing appears to be
   * happening.
   */
  private consume(file: string): void {
    for (let chunk = 0; chunk < MAX_CHUNKS_PER_TICK; chunk++) {
      if (!this.consumeChunk(file)) {
        return;
      }
    }
    this.log(`${path.basename(file)} has more to read; continuing next tick`);
  }

  /**
   * One bounded read. Returns true when there may be more waiting.
   *
   * All offset arithmetic is done on **bytes**. Deriving the new offset from the
   * decoded string is only equivalent when the read began on a character
   * boundary: otherwise the orphan continuation bytes decode to U+FFFD at three
   * bytes each, `Buffer.byteLength` of the decoded text overshoots the bytes
   * actually covered, and the next read starts *inside* the following line. That
   * line then fails to parse and is dropped in silence — and a missing edit is
   * exactly the case where reconstruction still verifies and still returns the
   * wrong baseline.
   */
  private consumeChunk(file: string): boolean {
    const offset = this.offsets.get(file);
    const size = sizeOf(file);
    if (size < offset) {
      // Truncated or replaced: re-attach at the end rather than replaying it.
      this.offsets.set(file, size);
      this.unaligned.add(file);
      return false;
    }
    if (size === offset) {
      return false;
    }

    const length = Math.min(size - offset, READ_CHUNK_BYTES);
    let fd: number | undefined;
    let view: Buffer | undefined;
    try {
      fd = fs.openSync(file, "r");
      const buf = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buf, 0, length, offset);
      // allocUnsafe leaves anything past `read` uninitialised, so every scan and
      // every decode below has to be bounded by what was actually read.
      view = buf.subarray(0, read);
    } catch {
      return false;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
    if (view.length === 0) {
      return false;
    }

    const lastNl = view.lastIndexOf(0x0a);
    if (lastNl < 0) {
      if (length >= size - offset) {
        // The window covered the whole tail, so the missing newline just means
        // the last line is still being appended. Wait for the rest of it.
        return false;
      }
      // A single line longer than the chunk. Skipping it is the only option that
      // keeps the watcher alive: leaving the offset where it is re-reads the same
      // chunk on every tick forever — synchronously, on the extension-host
      // thread — and every later edit in the session becomes invisible with no
      // error and no warning.
      this.offsets.set(file, offset + view.length);
      this.unaligned.add(file);
      this.log(`skipping an oversized line in ${path.basename(file)}`);
      return true;
    }

    let from = 0;
    if (this.unaligned.delete(file)) {
      // Everything up to the first newline is the tail of a line whose start we
      // never saw. Dropping it explicitly beats relying on JSON.parse to reject
      // it.
      from = view.indexOf(0x0a) + 1;
    }
    const consumable = view.toString("utf8", from, lastNl + 1);
    const next = offset + lastNl + 1;
    this.offsets.set(file, next);
    this.lastConsumedAt = Date.now();

    for (const line of consumable.split("\n")) {
      if (line.trim()) {
        this.handleLine(line);
      }
    }
    return next < size;
  }

  private handleLine(line: string): void {
    const parsed = parseTranscriptLine(line);
    if (!parsed) {
      return;
    }
    for (const use of parsed.uses) {
      this.handleToolUse(use.name, use.input, use.id, parsed.timestamp);
    }
    // Results live in a *user* message, which is why they used to be invisible
    // here: the loop only ever looked at tool_use blocks.
    for (const result of parsed.results) {
      this.handleToolResult(result.toolUseId, result.failed);
    }
  }

  private handleToolUse(
    name: string,
    input: Record<string, unknown>,
    id: string | undefined,
    toolTs: number | undefined
  ): void {
    let filePath = filePathOf(input);
    if (!filePath) {
      return;
    }
    if (!path.isAbsolute(filePath)) {
      filePath = path.resolve(this.cwd, filePath);
    }
    // Claude edits files outside the open folder all the time — its own
    // settings, a scratch file in /tmp, a sibling repository it was asked to
    // read. Tracking those would write verbatim copies of them into *this*
    // workspace's state and list them in a view that cannot show them.
    //
    // The ignore rules are checked in the same breath, and it has to be here
    // rather than at registration: a `write` reads the file a few lines below to
    // capture what it is about to overwrite, so a `.env` excluded from review
    // would otherwise be held in memory for the lifetime of the snapshot.
    if (!this.store.isInScope(filePath) || this.store.isIgnored(filePath)) {
      return;
    }

    const event: EditEvent | undefined = editEventFor(name, input);
    if (!event) {
      return;
    }

    // A record we have already acted on. Real transcripts are not append-only —
    // the same tool_use appears twice, at different byte offsets — and ingesting
    // an edit twice makes the reverse-apply fail, which silently demotes the file
    // to "not reviewable" for the rest of the session. Checked before the snapshot
    // below: re-reading the file for a call that ran long ago would capture
    // Claude's output against a stale tool timestamp.
    if (id !== undefined && this.seenUseIds.has(id)) {
      return;
    }
    if (event.kind === "write") {
      // Read the file now, before the tool runs, and record what proves it: this
      // is the only chance at the pre-write content.
      this.captureWriteSnapshot(filePath, toolTs);
    }
    // Without an id there is nothing to correlate a result with, so the call can
    // never be confirmed. Park it under a key no result will ever match: the file
    // then becomes unreviewable rather than being reconstructed from a guess.
    const key = id ?? `no-id:${++this.unknownUseSequence}`;
    this.pendingUse.set(key, { path: filePath, event, ts: Date.now() });
    this.lastActivityAt = Date.now();

    // Recompute promptly if we already have a baseline (e.g. from a hook).
    this.withStoreWork(() => this.store.recompute(filePath));

    // Keep the register timer armed while the call is in flight, so the
    // reconstruction waits for the result instead of running without it.
    if (!this.store.hasBaseline(filePath)) {
      this.scheduleRegister(filePath);
    }

    // Its result was already in a line we read earlier.
    if (id !== undefined && this.earlyResults.has(id)) {
      const failed = this.earlyResults.get(id) === true;
      this.earlyResults.delete(id);
      this.settlePending(id, failed);
    }
  }

  /**
   * Commit a tool call's edit only once its result says it actually landed.
   *
   * A refused edit ("String to replace not found in file"), a denied permission
   * prompt and a duplicated record all leave a tool_use block behind, and
   * reverse-applying an edit that never happened produces a baseline that
   * *verifies* — the phantom edit replays forward too — and is wrong. About one
   * failed edit per session is normal.
   */
  private handleToolResult(id: string, failed: boolean): void {
    if (this.seenUseIds.has(id)) {
      return; // already settled; a repeated result record must not commit twice
    }
    if (!this.pendingUse.has(id)) {
      // Out-of-order line: remember the verdict for when the call turns up.
      if (this.earlyResults.size >= SEEN_IDS_MAX) {
        const oldest = this.earlyResults.keys().next();
        if (!oldest.done) {
          this.earlyResults.delete(oldest.value);
        }
      }
      this.earlyResults.set(id, failed);
      return;
    }
    this.settlePending(id, failed);
  }

  private settlePending(id: string, failed: boolean): void {
    const pending = this.pendingUse.get(id);
    if (!pending) {
      return;
    }
    this.pendingUse.delete(id);
    this.rememberUseId(id);
    if (failed) {
      this.log(
        `ignoring a failed ${pending.event.kind} on ${pending.path}: the tool reported an error`
      );
      // The file may now have no reason to be tracked at all; the register timer
      // still runs and will report it unreviewable if some other call is pending.
      return;
    }
    const list = this.perFileEdits.get(pending.path) ?? [];
    list.push(pending.event);
    this.perFileEdits.set(pending.path, list);
    this.lastActivityAt = Date.now();

    this.withStoreWork(() => this.store.recompute(pending.path));
    if (!this.store.hasBaseline(pending.path)) {
      this.scheduleRegister(pending.path);
    }
  }

  private rememberUseId(id: string): void {
    if (this.seenUseIds.size >= SEEN_IDS_MAX) {
      // Sets iterate in insertion order, so this drops the oldest.
      const oldest = this.seenUseIds.values().next();
      if (!oldest.done) {
        this.seenUseIds.delete(oldest.value);
      }
    }
    this.seenUseIds.add(id);
  }

  /**
   * A `Write` is announced in the transcript before the tool runs, so the file on
   * disk right now *may* still be the pre-write content. Capture it together with
   * the evidence that decides whether it can be trusted;
   * `resolveWriteBaseline` makes that call later.
   */
  private captureWriteSnapshot(
    filePath: string,
    toolTs: number | undefined
  ): void {
    const existing = this.writeSnapshots.get(filePath);
    if (existing && Date.now() - existing.ts < WRITE_SNAPSHOT_TTL_MS) {
      return; // still describes the tool call in flight
    }
    let mtimeMs: number | undefined;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      mtimeMs = undefined;
    }
    const result = readFileBytesResult(filePath);
    if (result.kind === "error") {
      return;
    }
    if (result.kind === "binary") {
      // Not UTF-8 text: a decoded copy would be U+FFFD where the bytes were, and
      // an Undo would write that back over the file.
      return;
    }
    this.writeSnapshots.set(filePath, {
      content: result.kind === "ok" ? result.text : undefined,
      ts: Date.now(),
      mtimeMs,
      toolTs,
    });
  }

  /**
   * Trust a write snapshot only once the file has actually moved away from it.
   * If the content is unchanged we cannot tell "the write has not landed yet"
   * from "we looked after it landed", and guessing would mean offering an Undo
   * that empties the file.
   *
   * `created` travels with the baseline rather than being inferred from
   * `baseline === ""` later: an empty baseline is otherwise indistinguishable
   * from a file that existed and was empty, and Undo would then write an empty
   * file where it should remove the one Claude added.
   */
  private resolveWriteBaseline(
    filePath: string,
    current: string
  ): { baseline: string; created: boolean } | undefined {
    const snapshot = this.writeSnapshots.get(filePath);
    if (!snapshot) {
      return undefined;
    }
    const verdict = trustWriteSnapshot(
      snapshot,
      current,
      Date.now(),
      WRITE_SNAPSHOT_TTL_MS
    );
    if (verdict.kind === "reject") {
      // Always discarded, never merely unused: a snapshot kept alive after it
      // stopped describing a tool call in flight can be matched against a *later*
      // `current` and turn Claude's output into the baseline.
      this.log(
        `not trusting the pre-Write snapshot for ${filePath}: ${verdict.reason}`
      );
      this.writeSnapshots.delete(filePath);
      return undefined;
    }
    return { baseline: verdict.baseline, created: verdict.created };
  }

  /**
   * Reconstruct once the *transcript* has gone quiet, not merely once this file
   * has. A burst that touches several files, or a slow tool sequence with gaps
   * wider than the debounce, used to reconstruct from a partial edit list — and
   * because `registerBaseline` is a no-op when a baseline exists, that partial
   * baseline then became permanent for the whole review cycle.
   */
  private scheduleRegister(filePath: string): void {
    const existing = this.registerTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }
    this.registerTimers.set(
      filePath,
      setTimeout(() => {
        const quietFor = Date.now() - this.lastActivityAt;
        if (quietFor < SETTLE_MS) {
          this.registerTimers.delete(filePath);
          this.scheduleRegister(filePath);
          return;
        }
        // A tool call for this file is still waiting for its result. Wait too:
        // registering from the calls that *did* commit means reconstructing from
        // a subset of the file's edits, which verifies happily and is wrong.
        const pending = this.pendingFor(filePath);
        if (pending.length > 0) {
          const oldest = Math.min(...pending.map((p) => p.ts));
          if (Date.now() - oldest < PENDING_RESULT_TTL_MS) {
            this.registerTimers.delete(filePath);
            this.scheduleRegister(filePath);
            return;
          }
          // The results are never coming. Drop the calls and say so, rather than
          // reconstructing from what is left.
          for (const [id, entry] of [...this.pendingUse]) {
            if (entry.path === filePath) {
              this.pendingUse.delete(id);
            }
          }
          this.registerTimers.delete(filePath);
          this.unreviewable(
            filePath,
            "a tool call for this file has no recorded result, so what it changed is unknown"
          );
          return;
        }
        this.registerTimers.delete(filePath);
        this.register(filePath);
      }, SETTLE_MS)
    );
  }

  private pendingFor(filePath: string): PendingUse[] {
    return [...this.pendingUse.values()].filter((p) => p.path === filePath);
  }

  private register(filePath: string): void {
    if (this.disposed) {
      return;
    }
    // The store calls below fire change events that reach our own listener. It
    // would see a file with no baseline yet and forget everything we are in the
    // middle of registering, so hold it off and reconcile once at the end.
    const outcome = this.withStoreWork(() => this.registerNow(filePath));
    if (outcome !== "unreviewable") {
      // Reconcile: the register may have resolved the path outright (a baseline
      // equal to the current content resolves immediately), in which case its
      // accumulated events are spent. Skipped when the file was *noted*
      // unreviewable, because `forget` clears that note and the whole point of the
      // note is that the file stays listed with an explanation.
      this.forgetIfResolved(filePath);
    }
  }

  private registerNow(filePath: string): RegisterOutcome {
    if (this.store.hasBaseline(filePath)) {
      this.store.recompute(filePath);
      return "registered";
    }
    const events = this.perFileEdits.get(filePath) ?? [];
    if (events.length === 0) {
      // Nothing this file's tool calls did survived confirmation — every one of
      // them reported an error. There is no evidence Claude changed the file, so
      // there is nothing to report either.
      this.forget(filePath);
      return "nothing";
    }
    const read = readFileBytesResult(filePath);
    if (read.kind === "binary") {
      this.store.noteUnreviewable(
        filePath,
        "the file is not UTF-8 text, so it cannot be reviewed line by line"
      );
      return "unreviewable";
    }
    if (read.kind === "error") {
      this.log(`cannot read ${filePath} (${read.message}); leaving it alone`);
      return "nothing";
    }
    const current = read.kind === "ok" ? read.text : "";

    const result = reconstructBaseline(events, current);
    if (result.kind === "ok") {
      this.store.registerBaseline(filePath, result.baseline);
      this.log(`baseline reconstructed from transcript for ${filePath}`);
      return "registered";
    }

    // Reverse-applying failed — most often because a Write is involved. Fall
    // back to the snapshot taken when the Write was announced.
    const fromSnapshot = this.resolveWriteBaseline(filePath, current);
    if (fromSnapshot !== undefined) {
      this.store.registerBaseline(filePath, fromSnapshot.baseline, {
        created: fromSnapshot.created,
      });
      this.log(
        fromSnapshot.created
          ? `Write created ${filePath}: Undo will delete it`
          : `baseline captured before Write for ${filePath}`
      );
      return "registered";
    }

    this.log(
      `cannot reconstruct a baseline for ${filePath}: ${result.reason} — install the hooks for exact baselines`
    );
    // Record it rather than drop it: the changes view lists these so a file
    // Claude touched never disappears without an explanation.
    this.store.noteUnreviewable(filePath, result.reason);
    this.notifyOnce();
    return "unreviewable";
  }

  private unreviewable(filePath: string, reason: string): void {
    this.log(`cannot reconstruct a baseline for ${filePath}: ${reason}`);
    this.withStoreWork(() => {
      this.store.noteUnreviewable(filePath, reason);
      return "unreviewable" as const;
    });
    this.notifyOnce();
  }

  /** Run a block that drives the store without our own listener reacting to it. */
  private withStoreWork<T>(body: () => T): T {
    const outer = this.inStoreWork;
    this.inStoreWork = true;
    try {
      return body();
    } finally {
      this.inStoreWork = outer;
    }
  }

  /**
   * Tell the user once per session that some edits cannot be reviewed without
   * the hooks. Staying silent would look like the extension missed them.
   */
  private notifyOnce(): void {
    if (this.warned) {
      return;
    }
    this.warned = true;
    void vscode.window
      .showWarningMessage(
        "Claude changed a file in a way the session transcript cannot reconstruct exactly, so it is listed as not reviewable. Install the Claude Code hooks for exact baselines.",
        "Install hooks",
        "Dismiss"
      )
      .then((choice) => {
        if (choice === "Install hooks") {
          void vscode.commands.executeCommand("claudeKeepUndo.installHooks");
        }
      });
  }

  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    if (this.dirWatcher) {
      this.dirWatcher.close();
    }
    if (this.parentWatcher) {
      this.parentWatcher.close();
    }
    for (const t of this.registerTimers.values()) {
      clearTimeout(t);
    }
    this.registerTimers.clear();
    this.pendingUse.clear();
    this.earlyResults.clear();
    this.storeListener.dispose();
  }
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
