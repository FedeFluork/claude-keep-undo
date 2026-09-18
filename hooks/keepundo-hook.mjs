#!/usr/bin/env node
/**
 * Claude Code hook for the "Keep / Undo for Claude Code" VS Code extension.
 *
 * Installed for PreToolUse and PostToolUse on Edit|Write|MultiEdit. It receives
 * the hook payload as JSON on stdin and records, under the state directory the
 * extension passes in, the original (pre-edit) content of each file Claude
 * touches plus an append-only event log the extension watches.
 *
 * Usage (configured automatically by the extension):
 *   node keepundo-hook.mjs pre  --state "/path/to/state"
 *   node keepundo-hook.mjs post --state "/path/to/state"
 *
 * `--state` is VS Code's per-folder storage directory. It is deliberately not
 * derived from the payload's `cwd`: that is where `claude` was launched, which
 * differs from the folder VS Code has open whenever it was launched from a
 * subdirectory, and it would put verbatim copies of the user's source inside
 * their repository.
 *
 * In a multi-root window the extension also publishes `peers.d/` (one file per
 * window) and a combined `peers.json` next to that state. A session started in
 * one folder then photographs every workspace repo those windows want captured,
 * and routes Edit/Write files into the owning folder. A peer with `bash: false`
 * is skipped for shell-command snapshots (it is not a Git repository) but still
 * receives Edit/Write files that belong under it.
 *
 * This script must never block a tool call: it always exits 0 and swallows
 * errors, so a problem here can never interfere with Claude Code.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How long a staged pre-edit copy stays valid. A Pre hook whose Post never ran
 * (the tool call was denied, or Claude Code was killed mid-turn) would otherwise
 * leave a staging file that blocks every future capture for that path — and then
 * gets promoted as the "original" for an edit made days later.
 */
const PENDING_TTL_MS = 60_000;

/** The event log is a diagnostic, not a record: cap it rather than grow forever. */
const EVENTS_MAX_BYTES = 256 * 1024;

/**
 * Ceilings for the Bash path.
 *
 * These are constants rather than settings on purpose: they exist to stop a
 * pathological repository from making the hook slow or the state directory
 * large, not to be tuned. Every one of them degrades to "the file is listed with
 * an explanation", never to a guess.
 */
const BASH_MAX_STAGED = 200;
const BASH_MAX_STAGED_BYTES = 32 * 1024 * 1024;
const BASH_MAX_FILE_BYTES = 4 * 1024 * 1024;
const BASH_MAX_CANDIDATES = 500;
const BASH_MAX_RECOVER = 200;
/** git is fast, but it must never be the reason a shell command is held up. */
const GIT_TIMEOUT_MS = 10_000;

const argv = process.argv.slice(2);
const mode = argv[0] === "post" ? "post" : "pre";

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
}

/**
 * Must match `normalizePath`/`pathKey` in the extension's util.ts: macOS and
 * Windows are case-insensitive, so the same file reached through different
 * casing has to produce the same key on both sides.
 */
function pathKey(absPath) {
  const resolved = path.resolve(absPath);
  const normalized =
    process.platform === "linux" ? resolved : resolved.toLowerCase();
  return crypto
    .createHash("sha1")
    .update(normalized)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Is `absPath` inside `root`? Must agree with `ChangeStore.isInScope`, including
 * the case folding — and including the trap that `startsWith("..")` also matches
 * a directory genuinely named `..cache`.
 */
function isInside(root, absPath) {
  const fold = (p) =>
    process.platform === "linux"
      ? path.resolve(p)
      : path.resolve(p).toLowerCase();
  const rel = path.relative(fold(root), fold(absPath));
  if (rel === "" || path.isAbsolute(rel)) {
    return false;
  }
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

/** Must match `HOOK_PEERS_TTL_MS` in the extension's util.ts. */
const HOOK_PEERS_TTL_MS = 30 * 60 * 1000;

/**
 * Every workspace folder any open window wants photographed. Must match
 * `readHookPeerRegistrations` in the extension's util.ts.
 *
 * Claude Code only loads hooks from the project it was started in, so a Bash
 * call in repo A would otherwise never photograph sibling repo B. Each window
 * writes `peers.d/<window>.json`; `peers.json` is the combined list.
 */
function loadHookPeers(stateDir, selfRoot) {
  const fallback = selfRoot ? [{ root: selfRoot, stateDir }] : [];
  const lists = [];
  const dir = path.join(stateDir, "peers.d");
  let sawDir = false;
  try {
    const names = fs.readdirSync(dir);
    sawDir = true;
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".tmp")) {
        continue;
      }
      const filePath = path.join(dir, name);
      const folders = readPeersFile(filePath, true);
      if (folders.length > 0) {
        lists.push(folders);
      }
    }
  } catch {
    /* missing dir */
  }
  if (lists.length > 0) {
    return unionPeerLists(lists, fallback);
  }
  if (sawDir) {
    return fallback;
  }
  const combined = readPeersFile(path.join(stateDir, "peers.json"), false);
  return combined.length > 0 ? combined : fallback;
}

function readPeersFile(filePath, requireFresh) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  if (requireFresh && !isFreshPeerFile(filePath, raw)) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.folders)) {
      return [];
    }
    const folders = [];
    for (const item of parsed.folders) {
      if (
        item &&
        typeof item.root === "string" &&
        typeof item.stateDir === "string"
      ) {
        const folder = { root: item.root, stateDir: item.stateDir };
        if (item.bash === false) {
          folder.bash = false;
        }
        folders.push(folder);
      }
    }
    return folders;
  } catch {
    return [];
  }
}

function isFreshPeerFile(filePath, raw) {
  let ts;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.ts === "number" && Number.isFinite(parsed.ts)) {
      ts = parsed.ts;
    }
  } catch {
    ts = undefined;
  }
  if (ts === undefined) {
    try {
      ts = fs.statSync(filePath).mtimeMs;
    } catch {
      return false;
    }
  }
  return Date.now() - ts <= HOOK_PEERS_TTL_MS;
}

function unionPeerLists(lists, fallback) {
  const byRoot = new Map();
  for (const list of lists) {
    for (const folder of list) {
      const resolved = path.resolve(folder.root);
      const key =
        process.platform === "linux" ? resolved : resolved.toLowerCase();
      byRoot.set(key, folder);
    }
  }
  const folders = [...byRoot.values()];
  return folders.length > 0 ? folders : fallback;
}

/** Deepest published folder that contains `absPath`. */
function owningPeer(folders, absPath) {
  let best;
  let bestLen = -1;
  for (const folder of folders) {
    if (!folder.root || !isInside(folder.root, absPath)) {
      continue;
    }
    const n = path.resolve(folder.root).length;
    if (n > bestLen) {
      best = folder;
      bestLen = n;
    }
  }
  return best;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve(data);
      }
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    // Guard against a stdin that never closes, without holding the event loop.
    setTimeout(finish, 2000).unref();
  });
}

function atomicWrite(target, content) {
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  let fd;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fd = fs.openSync(tmp, "w");
    fs.writeFileSync(fd, content);
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
 * `created` records that the file did not exist when the original was captured.
 *
 * Without it a file Claude creates is stored as an empty baseline, which the
 * extension cannot tell apart from "the file existed and was empty" — so Undo
 * writes an empty file instead of removing the one Claude added.
 *
 * `bytes` is the source file's byte length. The extension re-measures the stored
 * baseline against it and refuses to track the file when the two disagree, so a
 * baseline that is not a byte-exact copy of what was captured can never reach an
 * Undo. Must stay in sync with `Sidecar` in the extension's util.ts.
 */
function writeSidecar(contentPath, absPath, created, bytes, ttlMs) {
  const record = { path: absPath, ts: Date.now(), created: created === true };
  // Omitted rather than guessed when it is not known: the extension reads a
  // missing `bytes` as "written by an older version" and falls back to its
  // heuristic, whereas a wrong number would demote a perfectly good baseline.
  if (typeof bytes === "number") {
    record.bytes = bytes;
  }
  // Only Bash stagings carry one. A shell command may legitimately run for
  // minutes — the tool's default timeout alone is double the global staging
  // TTL — so its copy has to outlive that TTL. An Edit staging records none and
  // keeps exactly the behaviour it always had.
  if (typeof ttlMs === "number") {
    record.ttlMs = ttlMs;
  }
  atomicWrite(`${contentPath}.json`, JSON.stringify(record, null, 2));
}

/**
 * Are these bytes UTF-8 text that survives a decode/encode round trip?
 *
 * The capture below has to read the file as a string, and any byte that is not
 * valid UTF-8 comes back as U+FFFD. Staging that is worse than staging nothing:
 * it is promoted verbatim to `baselines/`, the extension sees ordinary-looking
 * text on both sides, and an Undo writes the mojibake over the user's file. A
 * 2 KB PNG replaced by a text placeholder is destroyed outright; a windows-1252
 * source file loses one character per accent, quietly.
 *
 * Must agree with `isUtf8Text` in the extension's util.ts.
 */
function isUtf8Text(buf) {
  if (buf.includes(0)) {
    return false;
  }
  return Buffer.compare(Buffer.from(buf.toString("utf8"), "utf8"), buf) === 0;
}

function readSidecar(contentPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(`${contentPath}.json`, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The compiled ignore matcher, loaded from the extension's own build output.
 *
 * Shared rather than reimplemented: this decides whether a file is copied into
 * the state directory at all, and a hook that disagreed with the extension by
 * one pattern would either hide a file from review or take a copy of one the
 * user excluded. `createRequire` is what lets this ESM script load the CommonJS
 * that `tsc` emits, and both files ship in the same .vsix, so the path between
 * them cannot go stale.
 */
function loadIgnoreModule() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return createRequire(import.meta.url)(
      path.join(here, "..", "out", "ignore.js")
    );
  } catch {
    return undefined;
  }
}

/**
 * Compile the rules the extension published in `<stateDir>/ignore.json`, plus
 * every file that descriptor points at.
 *
 * File-backed sources are read here rather than travelling inside the
 * descriptor: `.keepundoignore` edited while VS Code was closed is then still in
 * force the next time Claude runs. A missing descriptor — an install that
 * predates it, or a workspace VS Code has never opened — falls back to the file
 * alone, which is the source the user can see.
 */
function loadIgnoreRules(stateDir, fallbackRoot) {
  const module = loadIgnoreModule();
  if (!module) {
    return { status: "unavailable" };
  }
  let descriptor;
  try {
    descriptor = JSON.parse(
      fs.readFileSync(path.join(stateDir, "ignore.json"), "utf8")
    );
  } catch {
    descriptor = undefined;
  }
  const root = descriptor?.root || fallbackRoot;
  if (!root) {
    // Nothing to make the paths relative to, so nothing can be matched.
    return { status: "none" };
  }
  const specs = Array.isArray(descriptor?.sources)
    ? descriptor.sources
    : [
        {
          label: "built-in defaults",
          patterns: module.DEFAULT_IGNORE_PATTERNS,
        },
        { label: ".keepundoignore", file: ".keepundoignore" },
      ];
  const sources = [];
  for (const spec of specs) {
    if (!spec || typeof spec !== "object") {
      continue;
    }
    if (Array.isArray(spec.patterns)) {
      sources.push({
        label: String(spec.label ?? ""),
        patterns: spec.patterns,
      });
      continue;
    }
    if (typeof spec.file !== "string") {
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(path.join(root, spec.file), "utf8");
    } catch {
      continue; // the file simply is not there
    }
    sources.push({
      label: String(spec.label ?? spec.file),
      patterns: module.parseIgnoreFile(text),
    });
  }
  const rules = module.compileIgnore(sources, {
    caseSensitive:
      typeof descriptor?.caseSensitive === "boolean"
        ? descriptor.caseSensitive
        : process.platform === "linux",
  });
  return rules.isEmpty ? { status: "none" } : { status: "ok", root, rules };
}

/**
 * Run git, and never throw.
 *
 * `missingPath` is the signal that a path is absent from a commit: `cat-file`
 * exits 128 with "does not exist in". That is what proves a file was *created*,
 * and it must stay distinguishable from every other failure — reading it as an
 * empty baseline would have Undo delete a file that existed.
 */
function git(cwd, args, stdin, raw = false) {
  try {
    const res = spawnSync("git", args, {
      cwd,
      input: stdin,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      encoding: raw ? "buffer" : "utf8",
    });
    if (res.error) {
      return { ok: false, missingPath: false };
    }
    const stderr = raw
      ? String(res.stderr ?? "")
      : (res.stderr ?? "").toString();
    const missingPath =
      res.status === 128 &&
      /does not exist in|exists on disk, but not in/.test(stderr);
    if (res.status !== 0) {
      return { ok: false, missingPath };
    }
    return raw
      ? { ok: true, missingPath: false, buf: res.stdout }
      : { ok: true, missingPath: false, text: res.stdout ?? "" };
  } catch {
    return { ok: false, missingPath: false };
  }
}

/**
 * The pure decision logic, loaded from the extension's own build output for the
 * same reason the ignore matcher is: one implementation, and a hook that cannot
 * disagree with the extension about what a status record means. If it will not
 * load, the Bash path does nothing at all — it must never fall back to a
 * hand-rolled parser.
 */
function loadBashSnapshot() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return createRequire(import.meta.url)(
      path.join(here, "..", "out", "detection", "bashSnapshot.js")
    );
  } catch {
    return undefined;
  }
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function sha1Hex(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function remove(target) {
  try {
    fs.rmSync(target, { force: true });
  } catch {
    /* ignore */
  }
}

/** Append an event, truncating the log when it gets large. */
function appendEvent(eventsPath, event) {
  try {
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    let size = 0;
    try {
      size = fs.statSync(eventsPath).size;
    } catch {
      size = 0;
    }
    if (size > EVENTS_MAX_BYTES) {
      // Keep the most recent half so a diagnostic tail survives the rotation.
      try {
        const text = fs.readFileSync(eventsPath, "utf8");
        const cut = text.indexOf("\n", Math.floor(text.length / 2));
        atomicWrite(eventsPath, cut >= 0 ? text.slice(cut + 1) : "");
      } catch {
        remove(eventsPath);
      }
    }
    fs.appendFileSync(eventsPath, event);
  } catch {
    /* ignore */
  }
}

/**
 * The git toplevel for the workspace, cached because it never changes and a
 * process spawn costs ~9 ms on every single Bash call.
 */
function gitToplevel(ctx) {
  const cacheFile = path.join(ctx.stateDir, "bash", "repo.json");
  const cached = readJson(cacheFile);
  if (
    cached &&
    cached.root === ctx.root &&
    typeof cached.ts === "number" &&
    Date.now() - cached.ts < 24 * 3600_000
  ) {
    return cached.top || undefined;
  }
  const res = git(ctx.root || ctx.cwd, ["rev-parse", "--show-toplevel"]);
  const top = res.ok ? (res.text || "").trim() : "";
  atomicWrite(
    cacheFile,
    JSON.stringify({ root: ctx.root, top, ts: Date.now() })
  );
  return top || undefined;
}

/**
 * Translate a path under the git toplevel into one under the folder VS Code has
 * open, or undefined when it is genuinely outside it.
 *
 * These are not always spelled the same. `git rev-parse --show-toplevel` returns
 * a *resolved* path, while `--root` is whatever VS Code was given — and on macOS
 * `/tmp` and `/var` are symlinks, so a repository under either produces
 * `/private/var/...` from git and `/var/...` from the workspace. Comparing them
 * directly puts every single file out of scope, silently. The same applies to any
 * workspace opened through a symlink.
 *
 * The path handed onward is always the workspace spelling, because that is what
 * `ChangeStore.isInScope` will compare against and what the user sees.
 */
function workspacePath(ctx, abs) {
  if (!ctx.root) {
    return abs;
  }
  const rel = relativeInside(ctx.root, abs);
  if (rel !== undefined) {
    return rel === "" ? undefined : path.join(ctx.root, rel);
  }
  if (ctx.rootReal) {
    const relReal = relativeInside(ctx.rootReal, abs);
    if (relReal !== undefined) {
      return relReal === "" ? undefined : path.join(ctx.root, relReal);
    }
  }
  return undefined;
}

/**
 * Relative path of `abs` under `root`, or undefined when it is not inside.
 * Prefers `path.relative` so the file-name case is kept; falls back to a
 * case-folded relative on Windows/macOS when the two spellings disagree.
 */
function relativeInside(root, abs) {
  if (!isInside(root, abs)) {
    return undefined;
  }
  const rel = path.relative(root, abs);
  if (rel === "") {
    return "";
  }
  if (
    !path.isAbsolute(rel) &&
    rel !== ".." &&
    !rel.startsWith(`..${path.sep}`)
  ) {
    return rel;
  }
  const fold = (p) =>
    process.platform === "linux"
      ? path.resolve(p)
      : path.resolve(p).toLowerCase();
  const folded = path.relative(fold(root), fold(abs));
  if (
    folded === "" ||
    path.isAbsolute(folded) ||
    folded === ".." ||
    folded.startsWith(`..${path.sep}`)
  ) {
    return "";
  }
  return folded;
}

/** Is this path one we are allowed to look at, let alone copy? */
function allowed(ctx, abs) {
  return !(
    ctx.ignore.status === "ok" && ctx.ignore.rules.ignores(ctx.ignore.root, abs)
  );
}

/**
 * Record that a file changed but its previous content is not known exactly.
 *
 * The hook cannot call into the extension, so the note goes on disk and the
 * extension drains it. This is what keeps the promise that a file Claude touched
 * is never silently absent from the review queue — the alternative to an exact
 * baseline is an explanation, never a guess.
 */
function writeNote(ctx, abs, reason, remedy) {
  const key = pathKey(abs);
  if (fs.existsSync(path.join(ctx.stateDir, "baselines", key))) {
    return; // it was recovered exactly after all
  }
  atomicWrite(
    path.join(ctx.stateDir, "unreviewable", `${key}.json`),
    JSON.stringify({
      path: abs,
      reason,
      ...(remedy ? { remedy } : {}),
      ts: Date.now(),
    })
  );
}

const REMEDY_TURN_ON =
  'Set claudeKeepUndo.detection.bashChanges to "recover" to capture these exactly.';

/**
 * Before the shell command runs: photograph the repository.
 *
 * One `git status` gives both halves of what Post needs — the commit the
 * worktree is being compared against, and the exact set of paths that already
 * differ from it. A path that is *clean* here needs nothing captured: git is
 * holding its content already. Only the ones that already differ have to be
 * copied aside, and in real repositories that set is tiny (1–3 files across the
 * four checkouts measured).
 */
function bashPre(payload, input, ctx) {
  if (ctx.bash === "off" || ctx.skipBash) {
    return;
  }
  if (input.run_in_background === true) {
    // Post fires when the shell is *launched*, not when it finishes, so the
    // comparison would sample a tree the command has barely begun to touch and
    // would keep touching afterwards. Detecting nothing is fine; detecting an
    // arbitrary half is not, because the user would believe the review is
    // complete.
    ctx.note("", "bash: backgrounded command, the file system was not sampled");
    return;
  }
  const snap = loadBashSnapshot();
  if (!snap) {
    ctx.note("", "bash: bashSnapshot unavailable");
    return;
  }
  // A command that cannot write to a file needs no snapshot at all. Skipping it
  // saves a `git status` and a process spawn on both phases, on roughly 43% of
  // real calls. Pre and Post ask the same question of the same string, so a
  // command skipped here is skipped there too.
  if (snap.looksReadOnly(input.command)) {
    return;
  }
  const top = gitToplevel(ctx);
  if (!top) {
    ctx.note("", "bash: not a git repository");
    return;
  }
  const status = git(top, [
    "status",
    "--porcelain=v2",
    "--branch",
    "-z",
    "-uall",
  ]);
  if (!status.ok) {
    ctx.note("", "bash: git status failed");
    return;
  }
  const parsed = snap.parseStatusV2(status.text);

  const slot = {
    v: 1,
    ts: Date.now(),
    ttlMs: snap.bashSlotTtl(input.timeout),
    mode: ctx.bash,
    top,
    head: parsed.head ?? null,
    notClean: [],
    staged: {},
    skipped: [],
  };

  let files = 0;
  let bytes = 0;
  for (const [rel, entry] of parsed.entries) {
    if (!snap.isOrdinary(entry) || entry.xy === "!!") {
      continue;
    }
    slot.notClean.push(rel);
    if (ctx.bash !== "recover") {
      continue; // the default tier reads no pre-existing file, ever
    }
    // Scope and the ignore rules are applied BEFORE the file is opened. This is
    // the promise that makes a .keepundoignore worth having for a .env.
    const abs = workspacePath(ctx, path.resolve(top, rel));
    if (!abs || !allowed(ctx, abs)) {
      continue;
    }
    const key = pathKey(abs);
    if (fs.existsSync(path.join(ctx.stateDir, "baselines", key))) {
      continue; // an older pre-Claude state is already recorded; keep it
    }
    if (snap.deletedInWorktree(entry)) {
      continue; // already gone: nothing to read
    }
    if (files >= BASH_MAX_STAGED || bytes >= BASH_MAX_STAGED_BYTES) {
      slot.skipped.push({
        p: rel,
        why: "too many files had already been changed to capture them all",
      });
      continue;
    }
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      slot.skipped.push({
        p: rel,
        why: "it could not be read before the command ran",
      });
      continue;
    }
    if (buf.length > BASH_MAX_FILE_BYTES) {
      slot.skipped.push({ p: rel, why: "it is too large to capture" });
      continue;
    }
    if (!isUtf8Text(buf)) {
      slot.skipped.push({
        p: rel,
        why: "it is not UTF-8 text, so it cannot be reviewed line by line",
      });
      continue;
    }
    const pendingFile = path.join(ctx.stateDir, "pending", key);
    const existing = readSidecar(pendingFile);
    const fresh =
      fs.existsSync(pendingFile) &&
      existing &&
      Date.now() - Number(existing.ts || 0) <
        (typeof existing.ttlMs === "number" ? existing.ttlMs : PENDING_TTL_MS);
    if (!fresh) {
      if (!atomicWrite(pendingFile, buf.toString("utf8"))) {
        slot.skipped.push({ p: rel, why: "it could not be copied aside" });
        continue;
      }
      writeSidecar(pendingFile, abs, false, buf.length, slot.ttlMs);
    }
    slot.staged[rel] = { key, sha: sha256(buf), bytes: buf.length };
    files++;
    bytes += buf.length;
  }

  atomicWrite(
    path.join(
      ctx.stateDir,
      "bash",
      `${snap.bashSlotId(payload, sha1Hex)}.json`
    ),
    JSON.stringify(slot)
  );
  ctx.note("", undefined, {
    bash: "pre",
    notClean: slot.notClean.length,
    staged: files,
  });
}

/**
 * After the shell command ran: compare, and resolve each changed file to either
 * a byte-exact baseline or a note saying why there is none.
 */
function bashPost(payload, input, ctx) {
  if (ctx.bash === "off" || ctx.skipBash || input.run_in_background === true) {
    return;
  }
  const snap = loadBashSnapshot();
  if (!snap || snap.looksReadOnly(input.command)) {
    return;
  }
  const slotFile = path.join(
    ctx.stateDir,
    "bash",
    `${snap.bashSlotId(payload, sha1Hex)}.json`
  );
  const slot = readJson(slotFile);
  if (!slot || slot.v !== 1) {
    ctx.note("", "bash: no snapshot was taken before the command");
    return;
  }
  try {
    if (Date.now() - slot.ts > slot.ttlMs) {
      ctx.note("", "bash: the snapshot outlived the command");
      return;
    }
    const status = git(slot.top, [
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "-uall",
    ]);
    if (!status.ok) {
      ctx.note("", "bash: git status failed");
      return;
    }
    const post = snap.parseStatusV2(status.text);

    // A `git commit`, `checkout` or `pull` inside the command leaves files clean
    // at Post while they differ from the commit we photographed. One extra
    // process, and only when HEAD actually moved.
    let headMoved = [];
    if (slot.head && post.head && slot.head !== post.head) {
      const diff = git(slot.top, [
        "diff",
        "--name-only",
        "-z",
        slot.head,
        post.head,
      ]);
      if (diff.ok) {
        headMoved = diff.text.split("\0").filter(Boolean);
      }
    }

    const buckets = snap.classify({
      mode: slot.mode,
      pre: {
        head: slot.head ?? undefined,
        notClean: new Set(slot.notClean),
        staged: new Set(Object.keys(slot.staged)),
        skipped: new Map((slot.skipped || []).map((x) => [x.p, x.why])),
      },
      post,
      headMoved,
    });
    if (buckets.length > BASH_MAX_CANDIDATES) {
      ctx.note("", `bash: too many changed files (${buckets.length})`);
      return;
    }
    if (buckets.length === 0) {
      return;
    }

    // One process for the whole candidate set. A path with a custom filter
    // driver cannot have its old content reproduced from the object store.
    const attrs = snap.parseCheckAttr(
      git(
        slot.top,
        ["check-attr", "--stdin", "-z", "filter"],
        buckets.map((b) => b.path).join("\0") + "\0"
      ).text || ""
    );

    let recovered = 0;
    for (const bucket of buckets) {
      const abs = workspacePath(ctx, path.resolve(slot.top, bucket.path));
      if (!abs || !allowed(ctx, abs)) {
        continue;
      }
      const key = pathKey(abs);
      const baselineFile = path.join(ctx.stateDir, "baselines", key);
      const pendingFile = path.join(ctx.stateDir, "pending", key);
      if (fs.existsSync(baselineFile)) {
        continue; // the oldest pre-Claude state is already recorded
      }

      const promote = () => {
        const staged = slot.staged[bucket.path];
        if (!staged) {
          writeNote(ctx, abs, snap.REASON_MODIFIED, REMEDY_TURN_ON);
          return;
        }
        let buf;
        try {
          buf = fs.readFileSync(pendingFile);
        } catch {
          writeNote(ctx, abs, snap.REASON_MODIFIED, REMEDY_TURN_ON);
          return;
        }
        // The copy must still be the bytes this call took. Another tool call
        // replacing it in between would otherwise be promoted as this command's
        // original.
        if (sha256(buf) !== staged.sha) {
          writeNote(
            ctx,
            abs,
            "another tool call replaced the copy taken before this command"
          );
          return;
        }
        let now;
        try {
          now = fs.readFileSync(abs);
        } catch {
          now = undefined;
        }
        if (now && sha256(now) === staged.sha) {
          // Unchanged after all. Promoting here would register a baseline equal
          // to the file, which resolves immediately — and worse, would show the
          // user's own unsaved buffer as Claude's change.
          remove(pendingFile);
          remove(`${pendingFile}.json`);
          return;
        }
        const sidecar = readSidecar(pendingFile);
        let ok = false;
        try {
          fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
          fs.renameSync(pendingFile, baselineFile);
          ok = true;
        } catch {
          try {
            fs.copyFileSync(pendingFile, baselineFile);
            remove(pendingFile);
            ok = true;
          } catch {
            /* ignore */
          }
        }
        if (ok) {
          writeSidecar(
            baselineFile,
            abs,
            sidecar?.created === true,
            sidecar?.bytes
          );
        }
        remove(`${pendingFile}.json`);
      };

      if (bucket.kind === "staged") {
        promote();
        continue;
      }

      if (bucket.kind === "created") {
        // A staging is proof the file existed for *some* Pre. Never delete on a
        // contradiction: fall through to the copy instead.
        if (fs.existsSync(pendingFile)) {
          promote();
          continue;
        }
        // Second, independent confirmation before an Undo is allowed to delete:
        // git must agree the path is absent from the commit.
        if (!slot.head) {
          writeNote(
            ctx,
            abs,
            "its content before the command could not be established"
          );
          continue;
        }
        const probe = git(slot.top, [
          "cat-file",
          "--filters",
          `--path=${bucket.path}`,
          `${slot.head}:${bucket.path}`,
        ]);
        if (!probe.missingPath) {
          writeNote(
            ctx,
            abs,
            "its content before the command could not be established"
          );
          continue;
        }
        if (atomicWrite(baselineFile, "")) {
          writeSidecar(baselineFile, abs, true, 0);
        }
        continue;
      }

      if (bucket.kind === "recover") {
        // `--filters`, never the raw blob: with `text=auto eol=crlf` the stored
        // object has LF line endings while the worktree has CRLF, so the raw
        // blob is not what the file held and an Undo would rewrite every line.
        const attr = attrs.get(bucket.path);
        if (attr !== "unspecified") {
          writeNote(
            ctx,
            abs,
            attr === undefined
              ? "git did not report whether a filter applies to it, so its previous content cannot be trusted"
              : "a git filter is configured for it, so its previous content cannot be reproduced exactly"
          );
          continue;
        }
        if (recovered >= BASH_MAX_RECOVER) {
          writeNote(
            ctx,
            abs,
            "too many files changed for all of them to be recovered"
          );
          continue;
        }
        recovered++;
        const got = git(
          slot.top,
          [
            "cat-file",
            "--filters",
            `--path=${bucket.path}`,
            `${slot.head}:${bucket.path}`,
          ],
          undefined,
          true
        );
        if (got.missingPath || !got.ok || !got.buf) {
          writeNote(
            ctx,
            abs,
            "its content before the command could not be recovered from git"
          );
          continue;
        }
        if (!isUtf8Text(got.buf)) {
          writeNote(
            ctx,
            abs,
            "it is not UTF-8 text, so it cannot be reviewed line by line"
          );
          continue;
        }
        if (atomicWrite(baselineFile, got.buf.toString("utf8"))) {
          writeSidecar(baselineFile, abs, false, got.buf.length);
        }
        continue;
      }

      writeNote(
        ctx,
        abs,
        bucket.reason,
        slot.mode === "recover" ? undefined : REMEDY_TURN_ON
      );
    }
  } finally {
    // Never leave a slot behind, whatever happened above.
    remove(slotFile);
  }
}

async function main() {
  const raw = await readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    return;
  }

  const cwd = payload.cwd || process.cwd();
  const stateDir = flag("--state");
  if (!stateDir) {
    return; // installed by a version that did not pass the state directory
  }

  const input = payload.tool_input || {};
  const root = flag("--root");
  const bashMode = flag("--bash") || "off";
  const eventsPath = path.join(stateDir, "events.ndjson");

  /** One diagnostic line about some path, with an optional reason. */
  const note = (forPath, skipped, extra) =>
    appendEvent(
      eventsPath,
      JSON.stringify({
        phase: mode,
        path: forPath,
        tool: payload.tool_name || "",
        ts: Date.now(),
        ...(skipped ? { skipped } : {}),
        ...(extra || {}),
      }) + "\n"
    );

  // Files the user excluded are not read, not staged and not promoted. This is
  // the only place that can make that promise: by the time the extension sees a
  // baseline, a verbatim copy of the file is already sitting on disk.
  //
  // A matcher that cannot be loaded leaves the capture running rather than
  // stopping detection dead — the extension applies the same rules again and
  // sweeps what it finds — but the event log says so, because taking copies of
  // an excluded file is not something to discover by accident.
  const ignore = loadIgnoreRules(stateDir, root);
  if (ignore.status === "unavailable") {
    note("", "ignore rules unavailable");
  }

  // Fan out on the tool NAME, never on the shape of `tool_input`. The extension
  // smoke-tests this script on every activation by piping a literal `{}` into
  // it, relying on it returning before it writes anything; `{}` carries no
  // `tool_name` and no `file_path`, so it falls through to the file-addressed
  // branch and returns there. Branching on "there is no file_path" instead would
  // turn that smoke test into a git probe on every window open.
  if (payload.tool_name === "Bash") {
    const peers = loadHookPeers(stateDir, root);
    const folders = peers.length > 0 ? peers : [{ root, stateDir }];
    for (const folder of folders) {
      let rootReal;
      try {
        rootReal = folder.root ? fs.realpathSync(folder.root) : undefined;
      } catch {
        rootReal = undefined;
      }
      const ctx = {
        stateDir: folder.stateDir,
        root: folder.root,
        rootReal,
        cwd,
        bash: bashMode,
        skipBash: folder.bash === false,
        ignore: loadIgnoreRules(folder.stateDir, folder.root),
        note,
      };
      if (mode === "pre") {
        bashPre(payload, input, ctx);
      } else {
        bashPost(payload, input, ctx);
      }
    }
    return;
  }

  let filePath = input.file_path || input.filePath || input.notebook_path;
  if (!filePath) {
    return;
  }
  if (!path.isAbsolute(filePath)) {
    filePath = path.resolve(cwd, filePath);
  }

  // Scope to a folder VS Code has open. Claude only runs this script from the
  // project it was started in, so a Write in a sibling repo used to be dropped
  // here. The published peer list covers every folder any open window wants
  // photographed; capture into the owning folder's state directory so that
  // folder's watcher sees it.
  const peers = loadHookPeers(stateDir, root);
  const owner = owningPeer(peers, filePath);
  let captureState = stateDir;
  let captureIgnore = ignore;
  if (owner) {
    captureState = owner.stateDir;
    if (owner.stateDir !== stateDir) {
      captureIgnore = loadIgnoreRules(owner.stateDir, owner.root);
    }
  } else if (root && !isInside(root, filePath)) {
    return;
  }

  const key = pathKey(filePath);
  const baselineFile = path.join(captureState, "baselines", key);
  const pendingFile = path.join(captureState, "pending", key);
  const record = (skipped) => note(filePath, skipped);

  if (
    captureIgnore.status === "ok" &&
    captureIgnore.rules.ignores(captureIgnore.root, filePath)
  ) {
    record("ignored");
    return;
  }

  if (mode === "pre") {
    // PRE runs *before* the edit is written. Capturing the original here is
    // correct, but we must NOT expose it as a baseline yet: at this instant the
    // file on disk still equals the captured content, so the extension would
    // see "no diff" and resolve (delete) the baseline before the edit lands.
    // So we stage it in pending/ and promote it on POST, once the edit exists.
    if (!fs.existsSync(baselineFile)) {
      const staged = readSidecar(pendingFile);
      const fresh =
        fs.existsSync(pendingFile) &&
        staged &&
        Date.now() - Number(staged.ts || 0) <
          (typeof staged.ttlMs === "number" ? staged.ttlMs : PENDING_TTL_MS);
      if (!fresh) {
        let original = "";
        let created = false;
        let bytes = 0;
        try {
          const buf = fs.readFileSync(filePath);
          if (!isUtf8Text(buf)) {
            // Not round-trippable: staging it would put a U+FFFD-mangled copy of
            // the user's file where a baseline belongs. Log the refusal rather
            // than returning silently, so the diagnostic log distinguishes
            // "deliberately skipped" from "the hook never ran".
            record("not utf-8");
            return;
          }
          original = buf.toString("utf8");
          bytes = buf.length;
        } catch (err) {
          if (err && err.code === "ENOENT") {
            // The file does not exist yet: this tool call creates it. The whole
            // file is an addition, and Undo must delete it, not empty it.
            created = true;
          } else {
            // Unreadable is NOT the same as absent. A transient EBUSY/EPERM —
            // a Windows share lock, an antivirus scan — would otherwise be
            // recorded as "Claude created this file", and Undo would delete a
            // file that existed and had content. Stage nothing and let the
            // transcript watcher or the next edit try again.
            return;
          }
        }
        if (atomicWrite(pendingFile, original)) {
          writeSidecar(pendingFile, filePath, created, bytes);
        }
      }
    }
  } else {
    // POST runs after the edit has been written to disk. Promote the staged
    // original to a real baseline so the extension computes a genuine diff
    // (original vs modified) and starts tracking the file.
    if (fs.existsSync(pendingFile)) {
      if (fs.existsSync(baselineFile)) {
        // An earlier edit already established the baseline, so this staging is
        // surplus. Dropping it here keeps it from lingering until the TTL and
        // from being promoted for some unrelated edit later on.
        remove(pendingFile);
        remove(`${pendingFile}.json`);
      } else {
        // Read the staging sidecar *before* the rename consumes it: it carries
        // whether this tool call created the file.
        const staged = readSidecar(pendingFile);
        let promoted = false;
        try {
          fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
          fs.renameSync(pendingFile, baselineFile);
          promoted = true;
        } catch {
          try {
            fs.copyFileSync(pendingFile, baselineFile);
            remove(pendingFile);
            promoted = true;
          } catch {
            /* ignore */
          }
        }
        if (promoted) {
          // Each baseline carries its own sidecar, so no shared index file has
          // to be read-modify-written by the hook and the extension at once.
          // `bytes` travels with it: the staging is what was measured, and the
          // promotion is a rename of exactly those bytes.
          writeSidecar(
            baselineFile,
            filePath,
            staged?.created === true,
            typeof staged?.bytes === "number" ? staged.bytes : undefined
          );
          remove(`${pendingFile}.json`);
        }
      }
    }
  }

  record();
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
