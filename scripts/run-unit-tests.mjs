#!/usr/bin/env node
/**
 * Run the compiled unit tests under `node --test`, on every Node version the
 * CI matrix covers.
 *
 * The obvious one-liner has no portable spelling. What `node --test` does with
 * its positional arguments changed under us:
 *
 *   - Node 18 and 20 read them as literal file or directory paths. A glob
 *     reaches the runner unexpanded and it reports
 *     `Could not find '.../out/test/unit/*.test.js'`.
 *   - Node 22 and later read them as glob patterns. A plain directory now
 *     matches itself, and the runner tries to load the directory as a module:
 *     `Cannot find module '.../out/test/unit'`.
 *
 * So the glob fails on 18/20 and the directory fails on 22+. Quoting does not
 * help either way, and leaving the glob unquoted only shifts the problem to
 * Windows, where cmd.exe does not expand globs at all. Expanding the list here
 * and passing explicit paths is the one form every version accepts.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = path.join(ROOT, "out", "test", "unit");

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.name.endsWith(".test.js")) {
      out.push(full);
    }
  }
  return out;
}

// Forward slashes, relative to the repository root. Node 22+ reads these as
// glob patterns, and in a glob a Windows backslash is an escape character, so
// an absolute `D:\a\...\util.test.js` would not match itself on the Windows
// runner. A relative POSIX path is a valid path on Windows and a valid glob
// everywhere.
const files = walk(TEST_DIR, [])
  .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
  .sort();

// An empty run reports success, which is the one outcome a test command must
// never invent: a compile that silently produced nothing would look green.
if (files.length === 0) {
  console.error(
    `No compiled unit tests found in ${path.relative(ROOT, TEST_DIR)}. ` +
      `Run \`npm run compile\` first.`
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: ROOT,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
// A runner killed by a signal reports a null status; that is a failure too.
process.exit(result.status ?? 1);
