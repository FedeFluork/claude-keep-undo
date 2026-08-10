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

/** Short, filesystem-safe id for an absolute file path. */
export function pathKey(absPath: string): string {
  return crypto
    .createHash("sha1")
    .update(normalizePath(absPath))
    .digest("hex")
    .slice(0, 16);
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

// --- shared on-disk layout ------------------------------------------------
//
// <stateDir>/                       (VS Code's per-workspace storage, NOT the repo)
//   baselines/<key>                 original (pre-Claude) content
//   baselines/<key>.json            { path, ts } sidecar — makes each baseline
//                                   self-describing so no shared index file has
//                                   to be read-modify-written by two processes
//   pending/<key>                   content staged between the Pre and Post hook
//   pending/<key>.json              { path, ts } sidecar — `ts` expires stagings
//   snapshots/<key>-<ts>            pre-Undo safety copies
//   events.ndjson                   append-only hook event log (size-capped)
//
// The state deliberately lives outside the workspace: baselines and snapshots
// are verbatim copies of the user's source, and keeping them in the repository
// is one `git add -A` away from committing whatever secrets those files held.

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
