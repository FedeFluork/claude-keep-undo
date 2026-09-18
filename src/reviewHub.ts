import * as path from "path";
import * as vscode from "vscode";
import {
  ApplyResult,
  ChangeStore,
  ReviewStore,
  TrackedFile,
  UndoBatchResult,
  UndoSnapshot,
  Unreviewable,
} from "./changeStore";
import { LineChange } from "./diff";
import {
  hooksState,
  maybePromptInstall,
  probeBashDetection,
  repairHooksIfStale,
  warnIfBashDetectionUnavailable,
} from "./detection/hookInstaller";
import { HookState } from "./detection/hookSettings";
import { KeepUndoWatcher } from "./detection/keepUndoWatcher";
import { TranscriptWatcher } from "./detection/transcriptWatcher";
import { IgnoreConfig } from "./ignoreConfig";
import * as settings from "./settings";
import { ClaudeSourceControl, DoubledGutterNotice } from "./ui/quickDiff";
import {
  atomicWrite,
  ensureDir,
  folderStateDir,
  hookPeersWindowFile,
  HookPeerFolder,
  HOOK_PEERS_FILE,
  HOOK_PEERS_HEARTBEAT_MS,
  legacyWorkspaceFallbackStateDir,
  moveDir,
  normalizePath,
  owningRoot,
  readHookPeerRegistrations,
  removeFile,
  serializeHookPeerRegistration,
  serializeHookPeers,
  stateDirHasContent,
  writeFolderIdentity,
} from "./util";

/**
 * One workspace folder's review machinery: its own store, ignore rules, hooks,
 * transcript watcher and Source Control entry.
 */
export class FolderSession implements vscode.Disposable {
  readonly ignore: IgnoreConfig;
  readonly store: ChangeStore;
  readonly stateDir: string;
  /**
   * The Bash hook must not photograph this folder. Set after `git rev-parse`
   * fails here — typically a sibling that only holds the `.code-workspace` file.
   * Edit/Write routing is unchanged: this folder still owns the files under it.
   */
  skipBashPeer = false;
  private hookWatcher: KeepUndoWatcher | undefined;
  private transcript: TranscriptWatcher | undefined;
  private readonly scm: ClaudeSourceControl;
  private readonly gutterNotice: DoubledGutterNotice;
  private readonly hookWatch: vscode.Disposable;
  private readonly ignoreWatch: vscode.Disposable;
  private readonly fileWatch: vscode.Disposable;
  private readonly storeForwarders: vscode.Disposable[] = [];
  private readonly _onDidDropIgnored = new vscode.EventEmitter<string[]>();
  readonly onDidDropIgnored = this._onDidDropIgnored.event;
  private readonly _onDidHookSettings = new vscode.EventEmitter<void>();
  readonly onDidHookSettings = this._onDidHookSettings.event;

  constructor(
    readonly folder: vscode.WorkspaceFolder,
    private readonly context: vscode.ExtensionContext,
    private readonly log: (msg: string) => void,
    private readonly reviewStore: ReviewStore,
    confirmedIgnore: () => boolean
  ) {
    this.stateDir = resolveFolderStateDir(context, folder, log);
    ensureDir(this.stateDir);
    writeFolderIdentity(this.stateDir, this.root);
    this.log(`Active on ${this.root} (state: ${this.stateDir})`);
    this.ignore = new IgnoreConfig(this.root, this.stateDir, log);
    this.store = new ChangeStore(this.stateDir, this.root, log, this.ignore);
    this.scm = new ClaudeSourceControl(folder, this.store);
    this.gutterNotice = new DoubledGutterNotice(
      this.root,
      this.store,
      context.workspaceState
    );
    this.hookWatch = watchHookSettings(folder, () =>
      this._onDidHookSettings.fire()
    );
    this.fileWatch = watchTrackedFiles(folder, (absPath) => {
      if (this.store.isTracked(absPath)) {
        this.store.recompute(absPath);
      }
    });
    this.ignoreWatch = this.ignore.onDidChange(() => {
      const left = this.store.reconcileIgnored();
      if (left.length > 0 && !confirmedIgnore()) {
        this._onDidDropIgnored.fire(left);
      }
    });
  }

  /** Forward this folder's store events through the hub. */
  attachToHub(hub: ReviewHub): vscode.Disposable {
    const listeners = [
      this.store.onDidChange((uri) => hub.forwardChange(uri)),
      this.store.onDidDetect((uri) => hub.forwardDetect(uri)),
      this.onDidDropIgnored((left) => hub.forwardDroppedIgnored(left)),
      this.onDidHookSettings(() => hub.forwardSessionsChange()),
    ];
    this.storeForwarders.push(...listeners);
    return {
      dispose: () => {
        for (const l of listeners) {
          l.dispose();
        }
      },
    };
  }

  get root(): string {
    return this.folder.uri.fsPath;
  }

  get name(): string {
    return this.folder.name;
  }

  hookState(): HookState {
    try {
      return hooksState(
        this.root,
        this.context.extensionPath,
        this.stateDir,
        settings.bashChanges()
      );
    } catch (err) {
      this.log(`could not read the hook registration: ${String(err)}`);
      return "missing";
    }
  }

  syncDetectors(): void {
    if (settings.useHooks() && this.hookWatcher) {
      try {
        repairHooksIfStale(
          this.root,
          this.context.extensionPath,
          this.stateDir,
          settings.bashChanges(),
          this.log,
          this.context.workspaceState
        );
      } catch (err) {
        this.log(`could not inspect the hook registration: ${String(err)}`);
      }
    }
    if (settings.useHooks() && !this.hookWatcher) {
      this.hookWatcher = new KeepUndoWatcher(this.stateDir, this.store);
      let state: HookState = "missing";
      try {
        state = repairHooksIfStale(
          this.root,
          this.context.extensionPath,
          this.stateDir,
          settings.bashChanges(),
          this.log,
          this.context.workspaceState
        );
      } catch (err) {
        this.log(`could not inspect the hook registration: ${String(err)}`);
      }
      this.log(
        state === "ok"
          ? `Hooks detected in ${this.name}: real-time detection active.`
          : `Hooks not active in ${this.name} (${state}).`
      );
    } else if (!settings.useHooks() && this.hookWatcher) {
      this.hookWatcher.dispose();
      this.hookWatcher = undefined;
      this.log(`Hook watcher stopped for ${this.name}.`);
    }

    if (settings.useTranscript() && !this.transcript) {
      // The hub, not this folder's store: a session in this repo can edit a
      // file that belongs to another folder in the same window.
      this.transcript = new TranscriptWatcher(
        this.root,
        this.reviewStore,
        this.log
      );
      this.transcript.start();
      this.log(`Transcript watcher started for ${this.name}.`);
    } else if (!settings.useTranscript() && this.transcript) {
      this.transcript.dispose();
      this.transcript = undefined;
      this.store.clearUnreviewable();
      this.log(`Transcript watcher stopped for ${this.name}.`);
    }
  }

  dispose(): void {
    for (const listener of this.storeForwarders) {
      listener.dispose();
    }
    this.storeForwarders.length = 0;
    this.hookWatcher?.dispose();
    this.transcript?.dispose();
    this.hookWatch.dispose();
    this.fileWatch.dispose();
    this.ignoreWatch.dispose();
    this.gutterNotice.dispose();
    this.scm.dispose();
    this.ignore.dispose();
    this.store.dispose();
    this._onDidDropIgnored.dispose();
    this._onDidHookSettings.dispose();
  }
}

/**
 * Every workspace folder's review state, presented as one {@link ReviewStore}
 * so the rest of the extension does not have to know how many roots there are.
 *
 * Each folder keeps its own on-disk queue, keyed by that folder's path — not
 * by the VS Code workspace — so opening the same repo in another window, or
 * on its own, finds the same pending reviews.
 */
export class ReviewHub implements vscode.Disposable, ReviewStore {
  private readonly sessions = new Map<string, FolderSession>();
  private readonly _onDidChange = new vscode.EventEmitter<
    vscode.Uri | undefined
  >();
  readonly onDidChange = this._onDidChange.event;
  private readonly _onDidDetect = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidDetect = this._onDidDetect.event;
  private readonly _onDidSessionsChange = new vscode.EventEmitter<void>();
  readonly onDidSessionsChange = this._onDidSessionsChange.event;
  private readonly _onDidDropIgnored = new vscode.EventEmitter<string[]>();
  readonly onDidDropIgnored = this._onDidDropIgnored.event;
  private readonly folderListener: vscode.Disposable;
  private readonly windowFocus: vscode.Disposable;
  private heartbeat: NodeJS.Timeout | undefined;
  private confirmedIgnoreChange = false;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (msg: string) => void
  ) {
    this.folderListener = vscode.workspace.onDidChangeWorkspaceFolders(() =>
      this.syncFolders()
    );
    this.windowFocus = vscode.window.onDidChangeWindowState((state) => {
      if (!this.disposed && state.focused) {
        this.publishHookPeers();
      }
    });
    this.heartbeat = setInterval(() => {
      if (!this.disposed) {
        void this.refreshBashPeers(false);
      }
    }, HOOK_PEERS_HEARTBEAT_MS);
    this.heartbeat.unref?.();
    this.syncFolders();
  }

  /** Mark the next ignore-rule reconcile as user-confirmed (no toast). */
  beginConfirmedIgnore(): void {
    this.confirmedIgnoreChange = true;
  }

  endConfirmedIgnore(): void {
    this.confirmedIgnoreChange = false;
  }

  getFolders(): FolderSession[] {
    return [...this.sessions.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  get multiRoot(): boolean {
    return this.sessions.size > 1;
  }

  get primary(): FolderSession | undefined {
    const first = vscode.workspace.workspaceFolders?.[0];
    if (first) {
      const session = this.sessions.get(folderKey(first.uri));
      if (session) {
        return session;
      }
    }
    return this.getFolders()[0];
  }

  get stateDir(): string {
    return this.primary?.stateDir ?? this.fallbackStateDir();
  }

  sessionForPath(absPath: string): FolderSession | undefined {
    const owner = owningRoot(
      this.getFolders().map((s) => s.root),
      absPath
    );
    if (!owner) {
      return undefined;
    }
    return this.getFolders().find((s) => pathsEqual(s.root, owner));
  }

  sessionForRoot(root: string): FolderSession | undefined {
    for (const session of this.sessions.values()) {
      if (pathsEqual(session.root, root)) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * The session a command argument refers to: a folder tree node, an SCM
   * provider (which carries `rootUri`), or a file path.
   */
  sessionFromArg(arg: unknown): FolderSession | undefined {
    if (!arg || typeof arg !== "object") {
      return undefined;
    }
    const rec = arg as Record<string, unknown>;
    if (rec.type === "folder" && typeof rec.root === "string") {
      return this.sessionForRoot(rec.root);
    }
    const rootUri = rec.rootUri;
    if (rootUri instanceof vscode.Uri) {
      return this.sessionForRoot(rootUri.fsPath);
    }
    return undefined;
  }

  ignoreFor(absPath: string): IgnoreConfig | undefined {
    return this.sessionForPath(absPath)?.ignore ?? this.primary?.ignore;
  }

  patternCount(): number {
    return this.getFolders().reduce((n, s) => n + s.ignore.patternCount(), 0);
  }

  aggregatedHookState(): HookState {
    const states = this.getFolders().map((s) => s.hookState());
    if (states.length === 0) {
      return "missing";
    }
    if (states.includes("foreign")) {
      return "foreign";
    }
    if (states.includes("stale")) {
      return "stale";
    }
    if (states.includes("missing")) {
      return "missing";
    }
    return "ok";
  }

  hooksInstalledEverywhere(): boolean {
    const folders = this.getFolders();
    return folders.length > 0 && folders.every((s) => s.hookState() === "ok");
  }

  syncDetectors(): void {
    for (const session of this.getFolders()) {
      session.syncDetectors();
    }
    void this.refreshBashPeers(true);
  }

  async promptInstallHooks(): Promise<void> {
    const targets = this.getFolders().map((s) => ({
      workspaceRoot: s.root,
      stateDir: s.stateDir,
    }));
    await maybePromptInstall(this.context, targets);
  }

  refreshFromDisk(): void {
    // Move first, then load: a nested folder added in this window would
    // otherwise refresh the destination before the source has handed the file
    // over.
    this.rehomeAcrossFolders();
    for (const session of this.getFolders()) {
      session.store.refreshFromDisk();
    }
    this._onDidChange.fire(undefined);
  }

  forwardChange(uri: vscode.Uri | undefined): void {
    this._onDidChange.fire(uri);
  }

  forwardDetect(uri: vscode.Uri): void {
    this._onDidDetect.fire(uri);
  }

  forwardDroppedIgnored(left: string[]): void {
    this._onDidDropIgnored.fire(left);
  }

  forwardSessionsChange(): void {
    this._onDidSessionsChange.fire();
  }

  // --- ReviewStore ---------------------------------------------------------

  getTracked(): TrackedFile[] {
    return this.getFolders()
      .flatMap((s) => s.store.getTracked())
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  isTracked(absPath: string): boolean {
    return this.storeFor(absPath)?.isTracked(absPath) === true;
  }

  hasBaseline(absPath: string): boolean {
    return this.storeFor(absPath)?.hasBaseline(absPath) === true;
  }

  get(absPath: string): TrackedFile | undefined {
    return this.storeFor(absPath)?.get(absPath);
  }

  count(): number {
    return this.getFolders().reduce((n, s) => n + s.store.count(), 0);
  }

  isApplyingEdit(): boolean {
    return this.getFolders().some((s) => s.store.isApplyingEdit());
  }

  isUserTouched(absPath: string): boolean {
    return this.storeFor(absPath)?.isUserTouched(absPath) === true;
  }

  isCreated(absPath: string): boolean {
    return this.storeFor(absPath)?.isCreated(absPath) === true;
  }

  isInScope(absPath: string): boolean {
    const owner = this.sessionForPath(absPath);
    if (owner) {
      return owner.store.isInScope(absPath);
    }
    return this.getFolders().some((s) => s.store.isInScope(absPath));
  }

  isIgnored(absPath: string): boolean {
    return this.storeFor(absPath)?.isIgnored(absPath) === true;
  }

  getUnreviewable(): Unreviewable[] {
    return this.getFolders()
      .flatMap((s) => s.store.getUnreviewable())
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  noteUnreviewable(absPath: string, reason: string): void {
    this.storeFor(absPath)?.noteUnreviewable(absPath, reason);
  }

  clearUnreviewable(absPath?: string): void {
    if (absPath !== undefined) {
      this.storeFor(absPath)?.clearUnreviewable(absPath);
      return;
    }
    for (const session of this.getFolders()) {
      session.store.clearUnreviewable();
    }
  }

  noteUserEdit(absPath: string): void {
    this.storeFor(absPath)?.noteUserEdit(absPath);
  }

  getBaseline(absPath: string): string {
    return this.storeFor(absPath)?.getBaseline(absPath) ?? "";
  }

  hunkIndexAtLine(absPath: string, line: number): number | undefined {
    return this.storeFor(absPath)?.hunkIndexAtLine(absPath, line);
  }

  registerBaseline(
    absPath: string,
    baseline: string,
    options: { created?: boolean } = {}
  ): void {
    this.storeFor(absPath)?.registerBaseline(absPath, baseline, options);
  }

  reloadBaseline(absPath: string): void {
    this.storeFor(absPath)?.reloadBaseline(absPath);
  }

  recompute(absPath: string, silent = false, noResolve = false): void {
    this.storeFor(absPath)?.recompute(absPath, silent, noResolve);
  }

  keepHunk(absPath: string, index: number, fingerprint?: string): ApplyResult {
    return (
      this.storeFor(absPath)?.keepHunk(absPath, index, fingerprint) ??
      "unavailable"
    );
  }

  async undoHunk(
    absPath: string,
    index: number,
    fingerprint?: string
  ): Promise<ApplyResult> {
    const store = this.storeFor(absPath);
    return store ? store.undoHunk(absPath, index, fingerprint) : "unavailable";
  }

  keepLineChange(absPath: string, change: LineChange): ApplyResult {
    return (
      this.storeFor(absPath)?.keepLineChange(absPath, change) ?? "unavailable"
    );
  }

  async undoLineChange(
    absPath: string,
    change: LineChange
  ): Promise<ApplyResult> {
    const store = this.storeFor(absPath);
    return store ? store.undoLineChange(absPath, change) : "unavailable";
  }

  keepFile(absPath: string): void {
    this.storeFor(absPath)?.keepFile(absPath);
  }

  async undoFile(absPath: string): Promise<ApplyResult> {
    const store = this.storeFor(absPath);
    return store ? store.undoFile(absPath) : "unavailable";
  }

  keepAll(): void {
    for (const session of this.getFolders()) {
      session.store.keepAll();
    }
    this._onDidChange.fire(undefined);
  }

  keepAllIn(session: FolderSession): void {
    session.store.keepAll();
  }

  async undoAll(): Promise<UndoBatchResult> {
    return this.undoPaths(this.getTracked().map((f) => f.path));
  }

  async undoPaths(paths: string[]): Promise<UndoBatchResult> {
    const byStore = new Map<ChangeStore, string[]>();
    const skipped: string[] = [];
    for (const absPath of paths) {
      const store = this.storeFor(absPath);
      if (!store) {
        skipped.push(absPath);
        continue;
      }
      const list = byStore.get(store) ?? [];
      list.push(absPath);
      byStore.set(store, list);
    }
    const merged: UndoBatchResult = {
      applied: 0,
      reformatted: [],
      failed: [],
      deleted: [],
      skipped,
    };
    for (const [store, group] of byStore) {
      const part = await store.undoPaths(group);
      merged.applied += part.applied;
      merged.reformatted.push(...part.reformatted);
      merged.failed.push(...part.failed);
      merged.deleted.push(...part.deleted);
      merged.skipped.push(...part.skipped);
    }
    this._onDidChange.fire(undefined);
    return merged;
  }

  captureUndoSnapshot(absPath: string): UndoSnapshot | undefined {
    return this.storeFor(absPath)?.captureUndoSnapshot(absPath);
  }

  stampPostUndo(snapshots: UndoSnapshot[]): UndoSnapshot[] {
    return snapshots.flatMap((snap) => {
      const store = this.storeFor(snap.path);
      return store ? store.stampPostUndo([snap]) : [snap];
    });
  }

  async restoreUndoSnapshots(
    snapshots: UndoSnapshot[]
  ): Promise<{ failed: string[]; stale: string[] }> {
    const failed: string[] = [];
    const stale: string[] = [];
    const byStore = new Map<ChangeStore, UndoSnapshot[]>();
    for (const snap of snapshots) {
      const store = this.storeFor(snap.path);
      if (!store) {
        failed.push(snap.path);
        continue;
      }
      const list = byStore.get(store) ?? [];
      list.push(snap);
      byStore.set(store, list);
    }
    for (const [store, group] of byStore) {
      const part = await store.restoreUndoSnapshots(group);
      failed.push(...part.failed);
      stale.push(...part.stale);
    }
    return { failed, stale };
  }

  snapshotsLocation(): string {
    return this.primary?.store.snapshotsLocation() ?? this.fallbackStateDir();
  }

  snapshotLocations(): { name: string; dir: string }[] {
    return this.getFolders().map((s) => ({
      name: s.name,
      dir: s.store.snapshotsLocation(),
    }));
  }

  wouldDelete(absPath: string): boolean {
    return this.storeFor(absPath)?.wouldDelete(absPath) === true;
  }

  reconcileIgnored(): string[] {
    return this.getFolders().flatMap((s) => s.store.reconcileIgnored());
  }

  dispose(): void {
    this.disposed = true;
    this.folderListener.dispose();
    this.windowFocus.dispose();
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    this.withdrawHookPeers();
    this.disposeSessions();
    this._onDidChange.dispose();
    this._onDidDetect.dispose();
    this._onDidSessionsChange.dispose();
    this._onDidDropIgnored.dispose();
  }

  // --- internals -----------------------------------------------------------

  private storeFor(absPath: string): ChangeStore | undefined {
    const owner = this.sessionForPath(absPath);
    if (owner) {
      return owner.store;
    }
    // Outside every folder: the first store that would accept it (trackOutside).
    return this.getFolders().find((s) => s.store.isInScope(absPath))?.store;
  }

  private fallbackStateDir(): string {
    return folderStateDir(this.context.globalStorageUri.fsPath, "_none");
  }

  /**
   * Tell every folder's hook which folders any open window wants photographed.
   * Claude only loads hooks from the project it was started in, so a Bash call
   * in repo A would otherwise never photograph sibling repo B.
   *
   * Each window writes its own file; `peers.json` is the union. A browsing
   * window that opens A alone must not replace the A+B list another window
   * published.
   */
  private publishHookPeers(): void {
    const folders = this.peerFolderList();
    const text = serializeHookPeerRegistration(folders);
    const windowId = vscode.env.sessionId;
    for (const session of this.getFolders()) {
      atomicWrite(hookPeersWindowFile(session.stateDir, windowId), text);
      this.writeHookPeersUnion(session);
    }
  }

  private withdrawHookPeers(): void {
    for (const session of this.getFolders()) {
      this.withdrawHookPeersFrom(session);
    }
  }

  private withdrawHookPeersFrom(session: FolderSession): void {
    removeFile(hookPeersWindowFile(session.stateDir, vscode.env.sessionId));
    this.writeHookPeersUnion(session);
  }

  private writeHookPeersUnion(session: FolderSession): void {
    atomicWrite(
      path.join(session.stateDir, HOOK_PEERS_FILE),
      serializeHookPeers(
        readHookPeerRegistrations(session.stateDir, {
          root: session.root,
          stateDir: session.stateDir,
        })
      )
    );
  }

  private applyPeerFolders(): void {
    const folders = this.peerFolderList();
    for (const session of this.getFolders()) {
      session.store.setPeerFolders(folders);
    }
  }

  private peerFolderList(): HookPeerFolder[] {
    return this.getFolders().map((s) => ({
      root: s.root,
      stateDir: s.stateDir,
      ...(s.skipBashPeer ? { bash: false as const } : {}),
    }));
  }

  /**
   * Probe every folder, mark non-git siblings as Bash peers to skip, and tell
   * the hook. A toast is only for the first pass (or a settings/folder change):
   * the heartbeat re-probes so a later `git init` is picked up, without
   * repeating the message.
   */
  private async refreshBashPeers(announce: boolean): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (settings.bashChanges() === "off" || !settings.useHooks()) {
      return;
    }
    const probes = await Promise.all(
      this.getFolders().map(async (session) => ({
        session,
        problem: await probeBashDetection(session.root),
      }))
    );
    if (this.disposed) {
      return;
    }
    for (const { session, problem } of probes) {
      const skip = problem !== undefined;
      if (session.skipBashPeer !== skip && !announce) {
        this.log(
          skip
            ? `skipping shell-command detection in ${session.name}: ${
                problem === "no-git"
                  ? "Git is not available on the PATH"
                  : "not a Git repository"
              }`
            : `shell-command detection is available in ${session.name}`
        );
      }
      session.skipBashPeer = skip;
    }
    this.publishHookPeers();
    if (!announce) {
      return;
    }
    await warnIfBashDetectionUnavailable(
      probes.map(({ session, problem }) => ({
        root: session.root,
        name: session.name,
        problem,
      })),
      settings.bashChanges(),
      this.log,
      this.context.workspaceState
    );
  }

  private rehomeAcrossFolders(): boolean {
    let any = false;
    for (const session of this.getFolders()) {
      if (session.store.rehomeDisplaced()) {
        any = true;
      }
    }
    return any;
  }

  private syncFolders(): void {
    if (this.disposed) {
      return;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    const seen = new Set<string>();
    let changed = false;
    for (const folder of folders) {
      const key = folderKey(folder.uri);
      seen.add(key);
      if (this.sessions.has(key)) {
        continue;
      }
      const session = new FolderSession(
        folder,
        this.context,
        this.log,
        this,
        () => this.confirmedIgnoreChange
      );
      this.sessions.set(key, session);
      session.attachToHub(this);
      changed = true;
    }
    const remaining: HookPeerFolder[] = [];
    for (const [key, session] of this.sessions) {
      if (seen.has(key)) {
        remaining.push({ root: session.root, stateDir: session.stateDir });
      }
    }
    for (const [key, session] of [...this.sessions]) {
      if (!seen.has(key)) {
        // Nested folder leaving: hand its queue to whichever remaining root
        // still contains the file. A sibling leaving keeps its own state dir.
        // Ownership is the remaining folders only — including this one in the
        // set would keep nested files here as if the folder were still open.
        this.withdrawHookPeersFrom(session);
        session.store.rehomeToward(remaining);
        session.dispose();
        this.sessions.delete(key);
        changed = true;
      }
    }
    this.applyPeerFolders();
    this.publishHookPeers();
    const rehomed = this.rehomeAcrossFolders();
    if (changed || rehomed) {
      for (const session of this.getFolders()) {
        session.store.refreshFromDisk();
        session.syncDetectors();
      }
      void this.refreshBashPeers(true);
      this._onDidChange.fire(undefined);
      this._onDidSessionsChange.fire();
    }
  }

  private disposeSessions(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
  }
}

/**
 * Where this folder's review state lives: always under globalStorage, keyed by
 * the folder path, so the queue follows the repo rather than the window.
 *
 * Older builds used the per-workspace `storageUri` (unique to the `.code-workspace`
 * or the single-folder window) and a `workspaces/<key>` fallback. Those are
 * lifted once if the new location is empty.
 */
export function resolveFolderStateDir(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
  log: (msg: string) => void
): string {
  const dest = folderStateDir(
    context.globalStorageUri.fsPath,
    folder.uri.fsPath
  );
  if (stateDirHasContent(dest)) {
    return dest;
  }
  const sources: string[] = [];
  const workspaceStorage = context.storageUri?.fsPath;
  if (workspaceStorage && shouldInheritWorkspaceStorage(folder)) {
    sources.push(workspaceStorage);
  }
  sources.push(
    legacyWorkspaceFallbackStateDir(
      context.globalStorageUri.fsPath,
      folder.uri.fsPath
    )
  );
  for (const src of sources) {
    if (src === dest || !stateDirHasContent(src)) {
      continue;
    }
    if (moveDir(src, dest)) {
      log(`moved review state: ${src} -> ${dest}`);
      return dest;
    }
    log(`could not move ${src} into ${dest}`);
  }
  return dest;
}

/**
 * Pre-1.3.0 only tracked `workspaceFolders[0]`, and wrote that queue into the
 * *window's* storage. That data belongs to the first folder of a multi-root
 * workspace, or to the only folder of a single-root one.
 */
function shouldInheritWorkspaceStorage(
  folder: vscode.WorkspaceFolder
): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length <= 1) {
    return true;
  }
  return folders[0]?.uri.toString() === folder.uri.toString();
}

/**
 * Recompute a tracked file when it changes or disappears on disk.
 *
 * Claude often deletes with a shell command. That never opens an editor, so
 * the document listeners never fire, and the review queue would keep listing
 * a file that is gone — click then opens "file was not found".
 */
function watchTrackedFiles(
  folder: vscode.WorkspaceFolder,
  onEvent: (absPath: string) => void
): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, "**/*")
  );
  const notify = (uri: vscode.Uri) => onEvent(uri.fsPath);
  const listeners = [
    watcher.onDidCreate(notify),
    watcher.onDidChange(notify),
    watcher.onDidDelete(notify),
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

function folderKey(uri: vscode.Uri): string {
  return uri.toString();
}

function pathsEqual(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}
