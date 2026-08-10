import * as path from "path";

/**
 * A `.gitignore`-style path matcher.
 *
 * Written from scratch because the extension ships with no runtime
 * dependencies, and because VS Code exposes no way to match a glob against an
 * arbitrary path: `RelativePattern` can only be handed to the APIs that consume
 * a `DocumentSelector` or a `FileSystemWatcher`, never asked a question.
 *
 * Deliberately free of any `vscode` import — for two reasons. The unit tests run
 * in plain Node, where that module does not exist; and the Claude Code hook, a
 * separate Node process, loads the compiled `out/ignore.js` directly so that the
 * two sides can never disagree about what "ignored" means. A file the hook
 * decides to skip and the extension decides to track would be invisible in the
 * review queue; the reverse would copy a file the user asked to be left alone
 * into the state directory.
 *
 * The supported syntax is the practical subset of gitignore:
 *
 *   build/            a directory, at any depth
 *   /build            anchored at the workspace root
 *   *.log  temp?.txt  wildcards that do not cross a `/`
 *   [abc] [a-z] [!a]  character classes
 *   !pattern          re-includes; the last rule that matches wins
 *   # comment         and blank lines, ignored
 *   \# \! \(space)    an escape, for a name that starts or ends with one
 *
 * A double asterisk crosses directory boundaries in all three positions
 * gitignore gives it: leading (at any depth), trailing (everything inside), and
 * between two slashes (any number of directories in between).
 *
 * Not supported, deliberately: regular expressions. The whole point of the
 * syntax is that it is the one users already know from `.gitignore`.
 */

/** Patterns applied before every other source, unless switched off. */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  // Claude edits inside `.git` only through git itself, and a baseline of an
  // index or a ref is meaningless: they are not text the user reviews.
  ".git/",
  // An `npm install` run by Claude would otherwise queue thousands of files.
  "node_modules/",
];

/** One named origin of patterns, kept apart so a match can be explained. */
export interface IgnoreSource {
  /** Shown to the user when a rule has to be attributed. */
  label: string;
  patterns: string[];
}

export interface IgnoreOptions {
  /**
   * Whether `SRC/App.ts` and `src/app.ts` are different paths.
   *
   * Defaults to the platform rule the rest of the extension applies (see
   * `normalizePath` in util.ts): case-insensitive everywhere except Linux.
   */
  caseSensitive?: boolean;
}

/** The rule that decided a path's fate, for logs and for the UI. */
export interface IgnoreMatch {
  source: string;
  pattern: string;
  /** True when the deciding rule was a `!` re-inclusion. */
  negated: boolean;
}

interface Rule {
  re: RegExp;
  negated: boolean;
  /** Only matches a directory: the pattern ended in `/`. */
  dirOnly: boolean;
  pattern: string;
  source: string;
}

export class IgnoreRules {
  constructor(private readonly rules: Rule[]) {}

  /** How many patterns compiled successfully, across every source. */
  get size(): number {
    return this.rules.length;
  }

  get isEmpty(): boolean {
    return this.rules.length === 0;
  }

  /**
   * Is a path inside `root` ignored?
   *
   * A path that is not under `root` answers `false` rather than throwing: the
   * workspace scope is a separate question, decided by `ChangeStore.isInScope`,
   * and answering it here as well would give one setting two owners.
   */
  ignores(root: string, absPath: string, isDir = false): boolean {
    return this.match(root, absPath, isDir) !== undefined;
  }

  /** The rule that ignored this path, or undefined if none did. */
  match(root: string, absPath: string, isDir = false): IgnoreMatch | undefined {
    const rel = relativeToRoot(root, absPath);
    return rel === undefined ? undefined : this.matchRelative(rel, isDir);
  }

  /**
   * The same question against a path already made relative to the root, with
   * `/` separators.
   *
   * `isDir` describes the last segment only; every segment before it is a
   * directory by construction.
   */
  matchRelative(relPath: string, isDir = false): IgnoreMatch | undefined {
    const normalized = normalizeRelative(relPath);
    if (normalized === "") {
      return undefined;
    }
    if (this.rules.length === 0) {
      return undefined;
    }
    // Git decides directory by directory and never descends into an excluded
    // one, which is why "it is not possible to re-include a file if a parent
    // directory of that file is excluded". Walking the ancestors first, and
    // returning as soon as one of them is excluded, is that rule: without it a
    // `!build/keep.txt` would silently re-include a file under a `build/` that
    // the user believes they excluded wholesale.
    const segments = normalized.split("/");
    let prefix = "";
    for (let i = 0; i < segments.length - 1; i++) {
      prefix += `/${segments[i]}`;
      const decided = this.decide(prefix, true);
      if (decided) {
        return decided;
      }
    }
    return this.decide(`/${normalized}`, isDir);
  }

  ignoresRelative(relPath: string, isDir = false): boolean {
    return this.matchRelative(relPath, isDir) !== undefined;
  }

  /**
   * Apply every rule to one path, last match winning, and report the rule that
   * ignored it — or undefined when the path ends up included.
   */
  private decide(candidate: string, isDir: boolean): IgnoreMatch | undefined {
    let winner: Rule | undefined;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) {
        continue;
      }
      if (rule.re.test(candidate)) {
        winner = rule;
      }
    }
    if (!winner || winner.negated) {
      return undefined;
    }
    return {
      source: winner.source,
      pattern: winner.pattern,
      negated: winner.negated,
    };
  }
}

/**
 * Compile a list of sources into one matcher.
 *
 * Order matters: the sources are concatenated in the order given and the last
 * rule that matches a path decides it, so a later source can re-include with
 * `!` what an earlier one excluded.
 */
export function compileIgnore(
  sources: IgnoreSource[],
  options: IgnoreOptions = {}
): IgnoreRules {
  const caseSensitive = options.caseSensitive ?? process.platform === "linux";
  const rules: Rule[] = [];
  for (const source of sources) {
    for (const pattern of source.patterns) {
      const rule = compilePattern(pattern, source.label, caseSensitive);
      if (rule) {
        rules.push(rule);
      }
    }
  }
  return new IgnoreRules(rules);
}

/**
 * Split the text of a `.keepundoignore` (or a `.gitignore`) into candidate
 * patterns. Comments and blank lines survive this step and are dropped by
 * {@link compileIgnore}, so a caller can round-trip a file without losing them.
 */
export function parseIgnoreFile(text: string): string[] {
  // A BOM would otherwise become part of the first pattern, which then matches
  // nothing at all and gives no hint as to why.
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBom.split(/\r?\n/);
}

/** The starting point offered when the ignore file does not exist yet. */
export const IGNORE_FILE_TEMPLATE = `# Files and folders Claude Keep/Undo should not put up for review.
#
# Same syntax as .gitignore: one pattern per line, '#' starts a comment, a
# trailing '/' means "directory", a leading '!' re-includes something an
# earlier line excluded, and the last matching line wins.
#
# Changes to files matched here are never detected: no gutter bars, no entry in
# the review queue, and no copy of the file in the extension's storage.

# Generated output
# dist/
# build/

# Secrets — never copied aside, so they can never be restored either
# .env
# *.pem

# Lockfiles: large, machine-written, and reviewed by diffing the manifest
# package-lock.json
`;

/**
 * A path relative to `root`, with `/` separators, or undefined when it is not
 * under `root` at all.
 */
export function relativeToRoot(
  root: string,
  absPath: string
): string | undefined {
  const rel = path.relative(path.resolve(root), path.resolve(absPath));
  if (rel === "" || path.isAbsolute(rel)) {
    return undefined;
  }
  // `startsWith("..")` also matches a directory genuinely named `..cache`,
  // which would then be treated as outside the root.
  if (rel === ".." || rel.startsWith(`..${path.sep}`)) {
    return undefined;
  }
  return rel.split(path.sep).join("/");
}

function normalizeRelative(relPath: string): string {
  return relPath
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

/**
 * Turn one line into a rule, or return undefined for a line that is not one
 * (blank, a comment, or a pattern that survives none of the stripping below).
 */
function compilePattern(
  raw: string,
  source: string,
  caseSensitive: boolean
): Rule | undefined {
  let pattern = trimPattern(raw);
  if (pattern === "" || pattern.startsWith("#")) {
    return undefined;
  }

  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\#") || pattern.startsWith("\\!")) {
    // An escape whose only job was to get past the two checks above.
    pattern = pattern.slice(1);
  }

  let dirOnly = false;
  if (pattern.endsWith("/") && !pattern.endsWith("\\/")) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }
  if (pattern === "") {
    return undefined;
  }

  // A pattern with a slash anywhere in it is anchored to the root; one without
  // matches at any depth, which is expressed by giving it a leading `**`.
  const anchored = pattern.includes("/");
  if (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
  }
  const segments = pattern.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) {
    return undefined;
  }
  if (!anchored) {
    segments.unshift("**");
  }

  let body = "";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      // Trailing `**` means "everything inside", so the directory itself is not
      // matched by it — `a/**` leaves `a` alone and takes `a/b`.
      body += last ? "/.+" : "(?:/[^/]+)*";
      return;
    }
    body += `/${segmentToRegex(segment)}`;
  });

  return {
    // Candidates are matched with a leading `/` (see `matchRelative`), which is
    // what lets `**/x` collapse to zero segments and still anchor correctly.
    re: new RegExp(`^${body}$`, caseSensitive ? "" : "i"),
    negated,
    dirOnly,
    pattern: raw.trim(),
    source,
  };
}

/**
 * Trailing spaces are not part of a pattern unless escaped, which is how
 * gitignore lets a filename genuinely end in one.
 *
 * Leading whitespace goes too, which git does *not* do — there it is part of the
 * name. Here the patterns are as likely to come from a settings array or from a
 * hand-indented block in an editor as from a file, and a rule that silently
 * matches nothing because a line was indented is a worse outcome than losing the
 * ability to name a file that begins with a space.
 */
function trimPattern(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) {
    // An odd number of backslashes before it means the space is escaped.
    let backslashes = 0;
    let i = end - 2;
    while (i >= 0 && line[i] === "\\") {
      backslashes++;
      i--;
    }
    if (backslashes % 2 === 1) {
      break;
    }
    end--;
  }
  return line.slice(0, end).replace(/^\s+/, "");
}

/** One path segment as a regular expression. `*` and `?` never cross a `/`. */
function segmentToRegex(segment: string): string {
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "\\") {
      i++;
      out += i < segment.length ? escapeRegex(segment[i]) : "\\\\";
      continue;
    }
    if (ch === "*") {
      out += "[^/]*";
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    if (ch === "[") {
      const end = closingBracket(segment, i);
      if (end > i) {
        out += characterClass(segment.slice(i + 1, end));
        i = end;
        continue;
      }
      // No closing bracket: a literal `[`, which is a legal filename character.
      out += "\\[";
      continue;
    }
    out += escapeRegex(ch);
  }
  return out;
}

/** Index of the `]` that closes the class opened at `start`, or -1. */
function closingBracket(segment: string, start: number): number {
  let i = start + 1;
  if (segment[i] === "!" || segment[i] === "^") {
    i++;
  }
  // A `]` in the first position is a literal member of the class, not the end.
  if (segment[i] === "]") {
    i++;
  }
  for (; i < segment.length; i++) {
    if (segment[i] === "\\") {
      i++;
      continue;
    }
    if (segment[i] === "]") {
      return i;
    }
  }
  return -1;
}

/**
 * A character class, translated rather than passed through: the body can carry
 * anything the user typed, and an unescaped backslash or a `[` inside it would
 * otherwise change the meaning of the regular expression we build around it.
 */
function characterClass(body: string): string {
  let negated = false;
  let rest = body;
  if (rest.startsWith("!") || rest.startsWith("^")) {
    negated = true;
    rest = rest.slice(1);
  }
  let out = "";
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "\\") {
      i++;
      out += i < rest.length ? escapeClassMember(rest[i]) : "\\\\";
      continue;
    }
    // A range's dash is the one character that has to survive verbatim.
    out += ch === "-" ? "-" : escapeClassMember(ch);
  }
  if (out === "") {
    return "\\[\\]";
  }
  // `/` is never part of a path segment, so excluding it from a negated class
  // keeps `[!a]` from matching a separator.
  return negated ? `[^/${out}]` : `[${out}]`;
}

function escapeClassMember(ch: string): string {
  return /[\\\]^]/.test(ch) ? `\\${ch}` : escapeRegex(ch);
}

function escapeRegex(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}
