import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Canonical form of a path for identity purposes.
 *
 * macOS and Windows filesystems are case-insensitive by default, so
 * `/Users/x/Src/App.ts` and `/Users/x/src/app.ts` are the same file and must
 * produce the same key — otherwise the hook and the extension end up with two
 * baselines for one file. Linux is case-sensitive, so folding there would merge
 * genuinely different files.
 *
 * The hook script applies the identical rule; the two always run on the same
 * machine, so `process.platform` agrees.
 */
export function normalizePath(absPath: string): string {
  const resolved = path.resolve(absPath);
  return process.platform === "linux" ? resolved : resolved.toLowerCase();
}

/**
 * A Map whose keys are file paths, compared the way {@link normalizePath} does.
 *
 * On Windows the hook (git's `D:\...`) and the editor (`uri.fsPath`, often
 * `d:\...`) routinely disagree on drive-letter case. A plain Map then tracks the
 * file under one spelling while Keep/Undo look up the other — the queue shows
 * it, Undo says there is nothing to undo. Folding the key, not the stored
 * value, is what makes those the same file.
 */
export class PathMap<V> {
  private readonly map = new Map<string, V>();

  get(filePath: string): V | undefined {
    return this.map.get(normalizePath(filePath));
  }

  has(filePath: string): boolean {
    return this.map.has(normalizePath(filePath));
  }

  set(filePath: string, value: V): this {
    this.map.set(normalizePath(filePath), value);
    return this;
  }

  delete(filePath: string): boolean {
    return this.map.delete(normalizePath(filePath));
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  keys(): IterableIterator<string> {
    return this.map.keys();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  entries(): IterableIterator<[string, V]> {
    return this.map.entries();
  }

  [Symbol.iterator](): IterableIterator<[string, V]> {
    return this.map.entries();
  }
}

/** A Set of file paths, compared the way {@link normalizePath} does. */
export class PathSet {
  private readonly set = new Set<string>();

  add(filePath: string): this {
    this.set.add(normalizePath(filePath));
    return this;
  }

  has(filePath: string): boolean {
    return this.set.has(normalizePath(filePath));
  }

  delete(filePath: string): boolean {
    return this.set.delete(normalizePath(filePath));
  }

  clear(): void {
    this.set.clear();
  }

  get size(): number {
    return this.set.size;
  }

  values(): IterableIterator<string> {
    return this.set.values();
  }

  keys(): IterableIterator<string> {
    return this.set.keys();
  }

  [Symbol.iterator](): IterableIterator<string> {
    return this.set.values();
  }
}

/** Short, filesystem-safe id for an absolute file path. */
export function pathKey(absPath: string): string {
  return crypto
    .createHash("sha1")
    .update(normalizePath(absPath))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Is `absPath` a file or subdirectory of `root` — not the root itself, and not
 * something that merely shares a prefix (`/app` vs `/apple`)?
 *
 * Same rule `ChangeStore.isInScope` has always used; extracted so multi-root
 * routing and the store can share one answer.
 */
export function isInsideRoot(root: string, absPath: string): boolean {
  const rel = path.relative(normalizePath(root), normalizePath(absPath));
  if (rel === "" || path.isAbsolute(rel)) {
    return false;
  }
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

/**
 * The workspace folder that owns this file: the deepest root that contains it.
 *
 * Nested folders (a repo opened inside another) must not double-track: the
 * inner root wins. A path under no root yields `undefined`.
 */
export function owningRoot(
  roots: readonly string[],
  absPath: string
): string | undefined {
  let best: string | undefined;
  let bestLen = -1;
  for (const root of roots) {
    if (!isInsideRoot(root, absPath)) {
      continue;
    }
    const n = normalizePath(root).length;
    if (n > bestLen) {
      best = root;
      bestLen = n;
    }
  }
  return best;
}

/**
 * Should this folder's store review `absPath`?
 *
 * A file under a *peer* workspace folder belongs to that folder, even when
 * `trackOutside` is on — "outside the workspace" is not "the other repo in this
 * window". Nested peers take the inner root. Files under no folder follow
 * `trackOutside`.
 */
export function pathIsInFolderScope(
  absPath: string,
  folderRoot: string,
  peerRoots: readonly string[],
  trackOutside: boolean
): boolean {
  const owner = owningRoot([folderRoot, ...peerRoots], absPath);
  if (owner !== undefined) {
    return normalizePath(owner) === normalizePath(folderRoot);
  }
  return trackOutside;
}

/** Combined peer list the hook reads. Union of every window's registration. */
export const HOOK_PEERS_FILE = "peers.json";

/** Per-window peer registrations. Last-writer must not replace another window. */
export const HOOK_PEERS_DIR = "peers.d";

/** Rewrite this window's registration this often so a live window does not expire. */
export const HOOK_PEERS_HEARTBEAT_MS = 5 * 60_000;

/** Drop a window file that has not been rewritten within this interval. */
export const HOOK_PEERS_TTL_MS = 30 * 60_000;

/** Records which workspace folder a state directory belongs to. */
export const FOLDER_IDENTITY_FILE = "folder.json";

export interface HookPeerFolder {
  root: string;
  stateDir: string;
  /**
   * When `false`, the Bash hook must not photograph this folder. A sibling that
   * is not a Git repository still owns Edit/Write files, but `git status` there
   * cannot say what a shell command changed. Omitted means try — the hook's
   * own `rev-parse` is the fallback for an older peers file.
   */
  bash?: boolean;
}

export function serializeHookPeers(folders: readonly HookPeerFolder[]): string {
  return JSON.stringify({ v: 1 as const, folders });
}

export function serializeHookPeerRegistration(
  folders: readonly HookPeerFolder[],
  ts = Date.now()
): string {
  return JSON.stringify({ v: 1 as const, ts, folders });
}

/**
 * Folders this hook should photograph. Missing or malformed files fall back to
 * the session folder — a window that has never published peers, or an install
 * from before they existed.
 */
export function parseHookPeers(
  raw: string | undefined,
  fallback: HookPeerFolder
): HookPeerFolder[] {
  return parseHookPeersList(raw) ?? [fallback];
}

/** Well-formed folder list, or `undefined` when the payload cannot be used. */
export function parseHookPeersList(
  raw: string | undefined
): HookPeerFolder[] | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; folders?: unknown };
    if (parsed.v !== 1 || !Array.isArray(parsed.folders)) {
      return undefined;
    }
    const folders: HookPeerFolder[] = [];
    for (const item of parsed.folders) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const rec = item as {
        root?: unknown;
        stateDir?: unknown;
        bash?: unknown;
      };
      if (typeof rec.root === "string" && typeof rec.stateDir === "string") {
        const folder: HookPeerFolder = {
          root: rec.root,
          stateDir: rec.stateDir,
        };
        if (rec.bash === false) {
          folder.bash = false;
        }
        folders.push(folder);
      }
    }
    return folders.length > 0 ? folders : undefined;
  } catch {
    return undefined;
  }
}

/** One folder per root, last occurrence wins. Empty input yields `fallback`. */
export function unionHookPeers(
  lists: readonly HookPeerFolder[][],
  fallback: HookPeerFolder
): HookPeerFolder[] {
  const byRoot = new Map<string, HookPeerFolder>();
  for (const list of lists) {
    for (const folder of list) {
      byRoot.set(normalizePath(folder.root), folder);
    }
  }
  const folders = [...byRoot.values()];
  return folders.length > 0 ? folders : [fallback];
}

export function hookPeersWindowFile(
  stateDir: string,
  windowId: string
): string {
  return path.join(stateDir, HOOK_PEERS_DIR, `${pathKey(windowId)}.json`);
}

/**
 * Folders any currently registered window wants photographed. Per-window files
 * are the source of truth. `peers.json` is the combined list written for the
 * hook — used only when no `peers.d` directory exists yet (an older install).
 * An empty `peers.d` means no window is registered, not "reuse the last union".
 */
export function readHookPeerRegistrations(
  stateDir: string,
  fallback: HookPeerFolder
): HookPeerFolder[] {
  const lists = listHookPeerRegistrationLists(stateDir);
  if (lists.length > 0) {
    return unionHookPeers(lists, fallback);
  }
  if (fileExists(path.join(stateDir, HOOK_PEERS_DIR))) {
    return [fallback];
  }
  return (
    parseHookPeersList(readFileSafe(path.join(stateDir, HOOK_PEERS_FILE))) ?? [
      fallback,
    ]
  );
}

/**
 * Live per-window folder lists. Expired files are deleted so they cannot keep
 * a crashed window's capture scope alive.
 */
export function listHookPeerRegistrationLists(
  stateDir: string
): HookPeerFolder[][] {
  const lists: HookPeerFolder[][] = [];
  const dir = path.join(stateDir, HOOK_PEERS_DIR);
  for (const name of listDir(dir)) {
    if (!name.endsWith(".json") || name.endsWith(".tmp")) {
      continue;
    }
    const filePath = path.join(dir, name);
    const raw = readFileSafe(filePath);
    if (!isFreshHookPeerRegistration(raw, filePath)) {
      removeFile(filePath);
      continue;
    }
    const parsed = parseHookPeersList(raw);
    if (parsed) {
      lists.push(parsed);
    }
  }
  return lists;
}

export function isFreshHookPeerRegistration(
  raw: string | undefined,
  filePath: string,
  now = Date.now()
): boolean {
  const ts = hookPeerRegistrationTime(raw, filePath);
  if (ts === undefined) {
    return false;
  }
  return now - ts <= HOOK_PEERS_TTL_MS;
}

function hookPeerRegistrationTime(
  raw: string | undefined,
  filePath: string
): number | undefined {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { ts?: unknown };
      if (typeof parsed.ts === "number" && Number.isFinite(parsed.ts)) {
        return parsed.ts;
      }
    } catch {
      /* fall through to mtime */
    }
  }
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * True when some registered window still has `selfRoot` open without `destRoot`
 * (or, if `destRoot` is omitted, still has `selfRoot` at all). Opening a nested
 * layout in this window must not move files another window still treats as
 * belonging here.
 */
export function otherWindowHoldsFolder(
  sourceStateDir: string,
  selfRoot: string,
  destRoot?: string
): boolean {
  const self = normalizePath(selfRoot);
  const dest = destRoot === undefined ? undefined : normalizePath(destRoot);
  for (const list of listHookPeerRegistrationLists(sourceStateDir)) {
    const roots = new Set(list.map((folder) => normalizePath(folder.root)));
    if (!roots.has(self)) {
      continue;
    }
    if (dest === undefined || !roots.has(dest)) {
      return true;
    }
  }
  return false;
}

export function writeFolderIdentity(stateDir: string, root: string): void {
  atomicWrite(
    path.join(stateDir, FOLDER_IDENTITY_FILE),
    JSON.stringify({ v: 1 as const, root })
  );
}

export function readFolderIdentity(stateDir: string): string | undefined {
  const raw = readFileSafe(path.join(stateDir, FOLDER_IDENTITY_FILE));
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; root?: unknown };
    if (parsed.v === 1 && typeof parsed.root === "string" && parsed.root) {
      return parsed.root;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * State directories of folders nested inside `selfRoot`. An outer-only window
 * uses these to list reviews another window relocated into an inner store.
 */
export function descendantFolderStores(
  selfStateDir: string,
  selfRoot: string
): HookPeerFolder[] {
  return relatedFolderStores(selfStateDir, selfRoot).filter((folder) =>
    isInsideRoot(selfRoot, folder.root)
  );
}

/**
 * Nested folders inside this one, and parent folders this one sits inside.
 * Sibling repos share the `folders/` directory but are not related.
 */
export function relatedFolderStores(
  selfStateDir: string,
  selfRoot: string
): HookPeerFolder[] {
  const parent = path.dirname(selfStateDir);
  const selfDir = normalizePath(selfStateDir);
  const found: HookPeerFolder[] = [];
  for (const name of listDir(parent)) {
    const dir = path.join(parent, name);
    if (normalizePath(dir) === selfDir) {
      continue;
    }
    const root = readFolderIdentity(dir);
    if (!root) {
      continue;
    }
    if (isInsideRoot(selfRoot, root) || isInsideRoot(root, selfRoot)) {
      found.push({ root, stateDir: dir });
    }
  }
  return found;
}

/**
 * Path of this folder's own baseline or staging for `absPath`, whether or not it exists yet.
 */
export function ownStatePair(
  absPath: string,
  stateDir: string,
  kind: "baselines" | "pending"
): string {
  const dirOf = kind === "baselines" ? baselinesDir : pendingDir;
  return path.join(dirOf(stateDir), pathKey(absPath));
}

/**
 * Every related store that already has a baseline or staging for `absPath`.
 *
 * Used when an explicit Keep or Undo must update or remove the copy the user
 * is looking at — including one that lives in a parent or nested store —
 * without leaving a duplicate behind for the next refresh to rediscover.
 */
export function existingStatePairs(
  absPath: string,
  stores: readonly HookPeerFolder[],
  kind: "baselines" | "pending"
): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const folder of stores) {
    const content = ownStatePair(absPath, folder.stateDir, kind);
    const key = normalizePath(content);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (fileExists(content)) {
      found.push(content);
    }
  }
  return found;
}

/** Delete every related baseline or staging for `absPath`, with its sidecar. */
export function removeStatePairs(
  absPath: string,
  stores: readonly HookPeerFolder[],
  kind: "baselines" | "pending"
): number {
  let n = 0;
  for (const content of existingStatePairs(absPath, stores, kind)) {
    removeFile(content);
    removeFile(sidecarPath(content));
    n++;
  }
  return n;
}

/**
 * Path of the baseline or staging this window should *read* for `absPath`.
 *
 * This window's own store wins if it already has a copy. If this store has
 * none, fall back to a related store that does — parent or nested — so each
 * window can list a review the other captured. New captures still land in
 * `preferredStateDir`.
 *
 * Passive browsing must not move or delete the fallback copy. An explicit
 * Keep or Undo applies to that copy (see {@link existingStatePairs}).
 */
export function locateStatePair(
  absPath: string,
  stores: readonly HookPeerFolder[],
  kind: "baselines" | "pending",
  preferredStateDir: string
): string {
  const preferred = ownStatePair(absPath, preferredStateDir, kind);
  if (fileExists(preferred)) {
    return preferred;
  }
  const existing = stores.filter((folder) =>
    fileExists(ownStatePair(absPath, folder.stateDir, kind))
  );
  if (existing.length === 0) {
    return preferred;
  }
  const winner = owningPeer(existing, absPath) ?? existing[0];
  return ownStatePair(absPath, winner.stateDir, kind);
}

/** The peer folder that owns this path, or undefined when none contains it. */
export function owningPeer(
  folders: readonly HookPeerFolder[],
  absPath: string
): HookPeerFolder | undefined {
  const root = owningRoot(
    folders.map((f) => f.root),
    absPath
  );
  if (root === undefined) {
    return undefined;
  }
  const key = normalizePath(root);
  return folders.find((f) => normalizePath(f.root) === key);
}

/**
 * Move one file, falling back to copy+delete across filesystems.
 *
 * Same idea as {@link moveDir}, for a baseline or sidecar that is changing
 * which folder's state directory it lives in.
 */
export function moveFile(from: string, to: string): boolean {
  try {
    ensureDir(path.dirname(to));
    fs.renameSync(from, to);
    return true;
  } catch {
    try {
      ensureDir(path.dirname(to));
      fs.copyFileSync(from, to);
      fs.rmSync(from, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}

export type RelocateResult =
  "moved" | "kept-destination" | "missing" | "failed";

/**
 * Move a baseline/pending content+sidecar pair into another folder's matching
 * directory. If that directory already has this `pathKey`, keep the destination
 * copy and drop the source — two queues must not hold the same file.
 */
export function relocateStatePair(
  contentPath: string,
  destDir: string
): RelocateResult {
  if (!fileExists(contentPath)) {
    return "missing";
  }
  ensureDir(destDir);
  const dest = path.join(destDir, path.basename(contentPath));
  if (normalizePath(contentPath) === normalizePath(dest)) {
    return "moved";
  }
  const srcSidecar = sidecarPath(contentPath);
  const destSidecar = sidecarPath(dest);
  if (fileExists(dest)) {
    removeFile(contentPath);
    removeFile(srcSidecar);
    return "kept-destination";
  }
  if (!moveFile(contentPath, dest)) {
    return "failed";
  }
  if (fileExists(srcSidecar) && !moveFile(srcSidecar, destSidecar)) {
    moveFile(dest, contentPath);
    return "failed";
  }
  return "moved";
}

/**
 * Move baselines or stagings whose owner (among `owners`) is not this folder
 * into that owner's state directory.
 *
 * `owners` must include this folder when it is still in the window: otherwise a
 * nested inner store would treat the outer peer as the owner and bounce the
 * file back. When this folder is *leaving*, pass only the folders that remain.
 *
 * When *leaving*, a file is left in place if another window still has this
 * folder open. When still open, a file is left in place if another window
 * has this folder without the destination — merely opening a nested layout
 * must not hide (or steal) another window's originals.
 */
export function rehomeDisplacedPairs(
  sourceStateDir: string,
  selfRoot: string,
  owners: readonly HookPeerFolder[],
  kind: "baselines" | "pending",
  log?: (msg: string) => void,
  leaving = false
): number {
  if (owners.length === 0) {
    return 0;
  }
  const sourceDir =
    kind === "baselines"
      ? baselinesDir(sourceStateDir)
      : pendingDir(sourceStateDir);
  const self = normalizePath(selfRoot);
  let n = 0;
  for (const name of listDir(sourceDir)) {
    if (name.endsWith(".json") || name.endsWith(".tmp")) {
      continue;
    }
    const contentPath = path.join(sourceDir, name);
    const sidecar = readSidecar(contentPath);
    if (!sidecar) {
      continue;
    }
    const owner = owningPeer(owners, sidecar.path);
    if (!owner || normalizePath(owner.root) === self) {
      continue;
    }
    if (
      otherWindowHoldsFolder(
        sourceStateDir,
        selfRoot,
        leaving ? undefined : owner.root
      )
    ) {
      log?.(
        `left ${kind} for ${sidecar.path} in place: another window still uses this folder`
      );
      continue;
    }
    const destDir =
      kind === "baselines"
        ? baselinesDir(owner.stateDir)
        : pendingDir(owner.stateDir);
    const result = relocateStatePair(contentPath, destDir);
    if (result === "moved" || result === "kept-destination") {
      n++;
      log?.(
        result === "moved"
          ? `moved ${kind} for ${sidecar.path} into ${owner.root}`
          : `dropped duplicate ${kind} for ${sidecar.path}; ${owner.root} already has it`
      );
    } else if (result === "failed") {
      log?.(`could not move ${kind} for ${sidecar.path} into ${owner.root}`);
    }
  }
  return n;
}

/** Per-folder review state, keyed by the folder path so it follows the repo. */
export function folderStateDir(
  globalStorageFsPath: string,
  folderRoot: string
): string {
  return path.join(globalStorageFsPath, "folders", pathKey(folderRoot));
}

/**
 * Where 1.2.x fell back when `storageUri` was missing: still keyed by folder,
 * but under `workspaces/` rather than `folders/`.
 */
export function legacyWorkspaceFallbackStateDir(
  globalStorageFsPath: string,
  folderRoot: string
): string {
  return path.join(globalStorageFsPath, "workspaces", pathKey(folderRoot));
}

/** True when a state directory already holds baselines or staged copies. */
export function stateDirHasContent(dir: string): boolean {
  if (!fileExists(dir)) {
    return false;
  }
  return (
    listDir(baselinesDir(dir)).some(
      (name) => !name.endsWith(".json") && !name.endsWith(".tmp")
    ) ||
    listDir(pendingDir(dir)).some(
      (name) => !name.endsWith(".json") && !name.endsWith(".tmp")
    )
  );
}

/**
 * Encode a working directory the way Claude Code names its project folder under
 * ~/.claude/projects (every non-alphanumeric character becomes a dash).
 * Example: /Users/x/Documents/claude_keepundo -> -Users-x-Documents-claude-keepundo
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function claudeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

export function sessionDirFor(cwd: string): string {
  return path.join(claudeProjectsDir(), encodeProjectDir(cwd));
}

/** Per-Bash-call snapshots, and the cached git toplevel. */
export function bashDir(stateDir: string): string {
  return path.join(stateDir, "bash");
}

/**
 * Notes the hook leaves for files it could not establish a baseline for.
 *
 * The hook runs in its own process and cannot call `noteUnreviewable`, so the
 * explanation goes on disk and the extension drains it. Without this a file
 * changed by a shell command whose original was unrecoverable would simply be
 * absent from the review queue — indistinguishable, to the user, from Claude
 * not having touched it.
 */
export function unreviewableDir(stateDir: string): string {
  return path.join(stateDir, "unreviewable");
}

/**
 * Where Claude Code keeps its own pre-edit copies of the files it changes,
 * one directory per session. See detection/fileHistory.ts for what lives there
 * and why it is the most faithful baseline available.
 */
export function claudeFileHistoryDir(): string {
  return path.join(os.homedir(), ".claude", "file-history");
}

// --- shared on-disk layout ------------------------------------------------
//
// <stateDir>/                       (per *folder*, under VS Code globalStorage,
//                                   NOT the repo and not the VS Code workspace)
//   baselines/<key>                 original (pre-Claude) content
//   baselines/<key>.json            { path, ts } sidecar — makes each baseline
//                                   self-describing so no shared index file has
//                                   to be read-modify-written by two processes
//   pending/<key>                   content staged between the Pre and Post hook
//   pending/<key>.json              { path, ts } sidecar — `ts` expires stagings
//   snapshots/<key>-<ts>            pre-Undo safety copies
//   ignore.json                     ignore rules published for the hook process
//   folder.json                     which workspace folder this state dir is for
//   peers.d/<window>.json           this window's folders, so another window
//                                   cannot overwrite the combined peer list
//   peers.json                      union of every live window's registration, for
//                                   the hook running in one repo to capture
//                                   the others. A folder with bash:false is
//                                   still an Edit/Write owner, but is not
//                                   photographed on a shell command.
//   events.ndjson                   append-only hook event log (size-capped)
//
// Keyed by the folder path so the same repo keeps its review queue when opened
// alone, in another multi-root window, or after a reload. Deliberately outside
// the repository: baselines and snapshots are verbatim copies of the user's
// source, and keeping them there is one `git add -A` away from committing
// whatever secrets those files held.

export function baselinesDir(stateDir: string): string {
  return path.join(stateDir, "baselines");
}

export function pendingDir(stateDir: string): string {
  return path.join(stateDir, "pending");
}

export function snapshotsDir(stateDir: string): string {
  return path.join(stateDir, "snapshots");
}

/**
 * URI scheme for the recorded baseline shown on the left of a Claude diff. It
 * lives here, not in a UI module, because both the store and the UI need it and
 * the store must not depend on the UI.
 */
export const BASELINE_SCHEME = "claude-baseline";

/**
 * Right-hand side of a Claude diff when the file no longer exists. `file:`
 * cannot be opened — VS Code reports "The editor could not be opened because
 * the file was not found" — so a deleted file is shown against this empty
 * document instead. `uri.fsPath` is still the real path.
 */
export const CURRENT_SCHEME = "claude-current";

/** Where releases before 0.2.0 kept their state, inside the repository. */
export function legacyStateDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".claude", "keepundo");
}

/** Sidecar path for a content file (`<file>` -> `<file>.json`). */
export function sidecarPath(contentPath: string): string {
  return `${contentPath}.json`;
}

export interface Sidecar {
  path: string;
  ts: number;
  /**
   * The file did not exist when the baseline was captured: Claude created it.
   *
   * Without this flag a created file is recorded as `baseline = ""`, which is
   * indistinguishable from "the file existed and was empty" — and Undo then
   * writes an empty file instead of removing the one Claude added.
   */
  created?: boolean;
  /**
   * Byte length of the content this record describes, measured at capture time.
   *
   * Everything here is stored as UTF-8 text. A producer that decoded a non-UTF-8
   * file lossily hands us a string whose UTF-8 length no longer matches the
   * source (each bad byte becomes a three-byte U+FFFD), and writing that back on
   * Undo silently corrupts the file. Comparing the two lengths catches it
   * whatever the density of bad bytes — which the `looksBinary` heuristic, being
   * a density test on already-decoded text, cannot.
   *
   * Absent in records written before 1.1.1.
   */
  bytes?: number;
  /**
   * How long this staging stays valid, when it is not the global default.
   *
   * Only a Bash staging records one. A shell command may legitimately run for
   * minutes — the tool's own default timeout is double the 60 s staging TTL, and
   * 1.80% of real calls exceed it — so its copy has to outlive that TTL or the
   * command's own Post finds it expired. Raising the global TTL instead is not
   * an option: those 60 s are what stop a denied Edit's staging from being
   * promoted as the "original" for an edit made days later.
   *
   * Its presence also marks the staging as a Bash one, which is what lets the
   * sweep report an interrupted command without saying anything about an
   * ordinary expired Edit staging.
   */
  ttlMs?: number;
}

export function readSidecar(contentPath: string): Sidecar | undefined {
  const raw = readFileSafe(sidecarPath(contentPath));
  if (!raw) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as Sidecar).path === "string"
    ) {
      const value = parsed as Sidecar;
      const record: Sidecar = {
        path: value.path,
        ts: Number(value.ts) || 0,
        created: value.created === true,
      };
      // Left off entirely rather than set to undefined: callers distinguish "not
      // recorded" (a pre-1.1.1 sidecar) from any value, including zero.
      if (typeof value.bytes === "number") {
        record.bytes = value.bytes;
      }
      if (typeof value.ttlMs === "number") {
        record.ttlMs = value.ttlMs;
      }
      return record;
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

// --- file IO ---------------------------------------------------------------

export type ReadResult =
  | { kind: "ok"; text: string }
  | { kind: "missing" }
  | { kind: "error"; message: string };

/**
 * Read a file, distinguishing "not there" from "could not be read". Collapsing
 * the two makes an unreadable or deleted file look like an empty one, which in
 * this extension means "Claude deleted everything".
 */
export function readFileResult(filePath: string): ReadResult {
  try {
    return { kind: "ok", text: fs.readFileSync(filePath, "utf8") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "error", message: code ?? String(err) };
  }
}

export function readFileSafe(filePath: string): string | undefined {
  const result = readFileResult(filePath);
  return result.kind === "ok" ? result.text : undefined;
}

/** `readFileResult`, plus "the bytes on disk are not UTF-8 text". */
export type BytesReadResult =
  | { kind: "ok"; text: string; bytes: number }
  | { kind: "binary" }
  | { kind: "missing" }
  | { kind: "error"; message: string };

/**
 * Read a file and prove the decoded text represents its bytes exactly.
 *
 * `looksBinary` can only ever be a heuristic: by the time it runs the bytes are
 * gone, replaced by U+FFFD, and it has to guess from their density. A
 * windows-1252 source file with three accented characters in five thousand
 * passes it — and then Undo writes `Jos�` over `José`. Here the original
 * bytes are still in hand, so the test is exact: re-encode the decoded string
 * and require it to be byte-identical to what was read.
 *
 * NUL bytes are rejected as well. They are valid UTF-8 and would round-trip, but
 * a file that contains them is not text we can review line by line.
 */
export function readFileBytesResult(filePath: string): BytesReadResult {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "error", message: code ?? String(err) };
  }
  if (!isUtf8Text(buf)) {
    return { kind: "binary" };
  }
  return { kind: "ok", text: buf.toString("utf8"), bytes: buf.length };
}

/** Are these bytes UTF-8 text we can decode, edit and write back byte-exactly? */
export function isUtf8Text(buf: Buffer): boolean {
  if (buf.includes(0)) {
    return false;
  }
  return Buffer.compare(Buffer.from(buf.toString("utf8"), "utf8"), buf) === 0;
}

/**
 * Does this text look like something that was not UTF-8 to begin with?
 *
 * A density heuristic, and only as good as one: prefer `readFileBytesResult`
 * wherever the bytes are still available. This is for content that never came
 * from disk — a baseline reconstructed from a transcript, a hunk merged in
 * memory — where there is nothing exact left to compare against.
 */
export function looksBinary(text: string): boolean {
  if (text.indexOf("\u0000") >= 0) {
    return true;
  }
  const sample = text.length > 8192 ? text.slice(0, 8192) : text;
  if (sample.length === 0) {
    return false;
  }
  let replacements = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 0xfffd) {
      replacements++;
    }
  }
  // A handful of U+FFFD can legitimately appear in text; a density cannot.
  return replacements > 2 && replacements / sample.length > 0.005;
}

/**
 * A timestamp with a per-process counter appended.
 *
 * `Date.now()` alone is not unique: two writes in the same millisecond produce
 * the same name, so a temporary file can collide with another one in flight and
 * a snapshot can silently overwrite the snapshot taken just before it.
 */
let writeSequence = 0;
export function uniqueSuffix(): string {
  writeSequence = (writeSequence + 1) % 0xffffff;
  return `${Date.now().toString(36)}-${writeSequence.toString(36)}`;
}

export function fileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Write a file as atomically as the filesystem allows: create the parent
 * directory, write and flush a unique temporary file, then rename over the
 * target. The flush matters — without it a crash can leave a zero-length
 * baseline, which reads as "the file was empty before Claude touched it".
 *
 * Returns false instead of throwing — every caller sits on a VS Code event
 * handler where an exception surfaces as an extension-host error and leaves the
 * store half-updated. The temporary file is removed on any failure.
 */
export function atomicWrite(target: string, content: string): boolean {
  const tmp = `${target}.${process.pid}.${uniqueSuffix()}.tmp`;
  let fd: number | undefined;
  try {
    ensureDir(path.dirname(target));
    fd = fs.openSync(tmp, "w");
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, target);
    return true;
  } catch {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    return false;
  }
}

/**
 * Copy a file's *bytes* aside, as atomically as the filesystem allows.
 *
 * A recovery snapshot has to be byte-exact to be a recovery: writing
 * `readFileSync(p, "utf8")` back out would store U+FFFD in place of every byte
 * that was not valid UTF-8, so the copy taken to protect the user's file would
 * itself be the corrupted version.
 */
export function atomicCopy(
  from: string,
  to: string
): "copied" | "missing" | "error" {
  const tmp = `${to}.${process.pid}.${uniqueSuffix()}.tmp`;
  try {
    ensureDir(path.dirname(to));
    fs.copyFileSync(from, tmp);
    const fd = fs.openSync(tmp, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, to);
    return "copied";
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    return (err as NodeJS.ErrnoException)?.code === "ENOENT"
      ? "missing"
      : "error";
  }
}

export function removeFile(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    /* ignore */
  }
}

/** List directory entries, or an empty array when the directory is absent. */
export function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Move a directory tree, falling back to copy+delete across filesystems.
 * Used once, to lift pre-0.2.0 state out of the user's repository.
 */
export function moveDir(from: string, to: string): boolean {
  try {
    ensureDir(path.dirname(to));
    fs.renameSync(from, to);
    return true;
  } catch {
    try {
      fs.cpSync(from, to, { recursive: true, force: true });
      fs.rmSync(from, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}
