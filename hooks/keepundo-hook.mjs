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
 * `--state` is VS Code's per-workspace storage directory. It is deliberately not
 * derived from the payload's `cwd`: that is where `claude` was launched, which
 * differs from the folder VS Code has open whenever it was launched from a
 * subdirectory, and it would put verbatim copies of the user's source inside
 * their repository.
 *
 * This script must never block a tool call: it always exits 0 and swallows
 * errors, so a problem here can never interfere with Claude Code.
 */
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
  return crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Is `absPath` inside `root`? Must agree with `ChangeStore.isInScope`, including
 * the case folding — and including the trap that `startsWith("..")` also matches
 * a directory genuinely named `..cache`.
 */
function isInside(root, absPath) {
  const fold = (p) =>
    process.platform === "linux" ? path.resolve(p) : path.resolve(p).toLowerCase();
  const rel = path.relative(fold(root), fold(absPath));
  if (rel === "" || path.isAbsolute(rel)) {
    return false;
  }
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
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
function writeSidecar(contentPath, absPath, created, bytes) {
  const record = { path: absPath, ts: Date.now(), created: created === true };
  // Omitted rather than guessed when it is not known: the extension reads a
  // missing `bytes` as "written by an older version" and falls back to its
  // heuristic, whereas a wrong number would demote a perfectly good baseline.
  if (typeof bytes === "number") {
    record.bytes = bytes;
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
        { label: "built-in defaults", patterns: module.DEFAULT_IGNORE_PATTERNS },
        { label: ".keepundoignore", file: ".keepundoignore" },
      ];
  const sources = [];
  for (const spec of specs) {
    if (!spec || typeof spec !== "object") {
      continue;
    }
    if (Array.isArray(spec.patterns)) {
      sources.push({ label: String(spec.label ?? ""), patterns: spec.patterns });
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
  let filePath = input.file_path || input.filePath;
  if (!filePath) {
    return;
  }
  if (!path.isAbsolute(filePath)) {
    filePath = path.resolve(cwd, filePath);
  }

  // Scope to the folder VS Code has open. The hook sees every file Claude
  // touches — its own settings, a scratch file, a sibling repository — and
  // staging those would copy their verbatim content into this workspace's
  // storage before the extension ever gets a say. `--root` is absent from an
  // install made before 1.1.0, in which case nothing is filtered here and the
  // extension drops what it should not have.
  const root = flag("--root");
  if (root && !isInside(root, filePath)) {
    return;
  }

  const key = pathKey(filePath);
  const baselineFile = path.join(stateDir, "baselines", key);
  const pendingFile = path.join(stateDir, "pending", key);
  const eventsPath = path.join(stateDir, "events.ndjson");

  /** One diagnostic line, with an optional reason for having done nothing. */
  const record = (skipped) =>
    appendEvent(
      eventsPath,
      JSON.stringify({
        phase: mode,
        path: filePath,
        tool: payload.tool_name || "",
        ts: Date.now(),
        ...(skipped ? { skipped } : {}),
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
    record("ignore rules unavailable");
  } else if (
    ignore.status === "ok" &&
    ignore.rules.ignores(ignore.root, filePath)
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
        Date.now() - Number(staged.ts || 0) < PENDING_TTL_MS;
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
