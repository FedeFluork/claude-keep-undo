#!/usr/bin/env node
/**
 * Fail the build if any source file contains a NUL byte.
 *
 * This is not hypothetical. A stray `U+0000` inside a template literal compiles,
 * lints, formats and passes every test — a NUL is a perfectly good hash
 * separator, and it renders as nothing on screen, so it survives a careful
 * read-through too. What it does do is make the file binary:
 *
 *   - `git diff` reports "Binary files differ" instead of a reviewable diff;
 *   - `grep`, `diff` and several editors skip it by default;
 *   - `looksBinary()` in src/util.ts returns true for it, so this extension
 *     would refuse to review its own source as "not UTF-8 text".
 *
 * It has happened twice in this repository. `grep` cannot be used for the check
 * — `-I` skips binary files, which is exactly the set we are looking for, and
 * `-P` is unavailable on BSD grep — so the bytes are read directly.
 */
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["src", "hooks"];
const EXTENSIONS = new Set([".ts", ".mjs", ".js", ".json"]);
const EXTRA_FILES = ["package.json"];

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // an optional directory that does not exist here
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

const files = [...ROOTS.flatMap((r) => walk(r, [])), ...EXTRA_FILES];
const offenders = [];

for (const file of files) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    continue;
  }
  const at = bytes.indexOf(0);
  if (at >= 0) {
    const line = bytes.subarray(0, at).toString("utf8").split("\n").length;
    offenders.push(`${file}:${line}`);
  }
}

if (offenders.length > 0) {
  console.error(
    `NUL byte found in ${offenders.length} file(s). These are binary to git and ` +
      `to this extension's own UTF-8 check:\n  ${offenders.join("\n  ")}`
  );
  process.exit(1);
}

console.log(`no NUL bytes in ${files.length} source files`);
