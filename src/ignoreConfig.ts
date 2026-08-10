import * as path from "path";
import * as vscode from "vscode";
import { IgnorePredicate } from "./changeStore";
import {
  DEFAULT_IGNORE_PATTERNS,
  IGNORE_FILE_TEMPLATE,
  IgnoreMatch,
  IgnoreRules,
  IgnoreSource,
  compileIgnore,
  parseIgnoreFile,
  relativeToRoot,
} from "./ignore";
import {
  SECTION,
  ignorePatterns,
  useGitignore,
  useIgnoreDefaults,
  useIgnoreFile,
} from "./settings";
import { atomicWrite, fileExists, readFileSafe } from "./util";

/** The ignore file, in the workspace root, next to `.gitignore`. */
export const IGNORE_FILE_NAME = ".keepundoignore";

/**
 * The descriptor the Claude Code hook reads, written into the state directory.
 *
 * The hook is a separate Node process with no access to VS Code's settings, so
 * the extension — the only side that can read them — materialises the merge
 * here. File-backed sources travel as a *path* rather than as their contents:
 * the hook then reads them itself, and a `.keepundoignore` edited while VS Code
 * was closed is still in force the next time Claude runs.
 */
export const HOOK_IGNORE_FILE = "ignore.json";

/** Bound on the memoised decisions, cleared whenever the rules change. */
const CACHE_MAX = 4096;

interface HookSource {
  label: string;
  /** Literal patterns, for a source that is not a file. */
  patterns?: string[];
  /** A path relative to the root, read by the hook at the time it runs. */
  file?: string;
}

interface HookDescriptor {
  version: 1;
  root: string;
  caseSensitive: boolean;
  sources: HookSource[];
}

/**
 * Everything the extension knows about which files are not to be reviewed.
 *
 * Four sources, applied in this order, with the last rule that matches a path
 * deciding it — so a later source can re-include with `!` what an earlier one
 * excluded:
 *
 *   1. the built-in defaults          (`ignore.useDefaults`)
 *   2. `.gitignore` and `.git/info/exclude`  (`ignore.useGitignore`, off by default)
 *   3. `claudeKeepUndo.ignore.patterns`, which can be set per user or per workspace
 *   4. `.keepundoignore` in the workspace root  (`ignore.useIgnoreFile`)
 *
 * The file goes last because it is the project's own statement, committed and
 * shared, and the one a reader of the repository will look at first.
 */
export class IgnoreConfig implements IgnorePredicate, vscode.Disposable {
  private compiled: IgnoreRules | undefined;
  private readonly cache = new Map<string, boolean>();
  private readonly disposables: vscode.Disposable[] = [];
  private lastDescriptor = "";
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires when the rules change, so the store can reconcile what it holds. */
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly workspaceRoot: string,
    private readonly stateDir: string,
    private readonly log: (msg: string) => void
  ) {
    // `.gitignore` is watched whether or not it is currently in use: turning the
    // setting on later must not require a reload to pick the file up.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.Uri.file(workspaceRoot),
        `{${IGNORE_FILE_NAME},.gitignore}`
      )
    );
    this.disposables.push(
      watcher,
      watcher.onDidCreate(() => this.invalidate("the ignore file was created")),
      watcher.onDidChange(() => this.invalidate("the ignore file changed")),
      watcher.onDidDelete(() => this.invalidate("the ignore file was deleted")),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${SECTION}.ignore`)) {
          this.invalidate("the ignore settings changed");
        }
      }),
      this._onDidChange
    );
    this.writeHookDescriptor();
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  // --- queries -------------------------------------------------------------

  /** Is this file excluded from review? Always false outside the workspace. */
  isIgnored(absPath: string): boolean {
    const rules = this.rules();
    if (rules.isEmpty) {
      return false;
    }
    const cached = this.cache.get(absPath);
    if (cached !== undefined) {
      return cached;
    }
    const decided = rules.ignores(this.workspaceRoot, absPath);
    if (this.cache.size >= CACHE_MAX) {
      // A whole-map clear rather than an eviction policy: the map is a pure
      // memo of a pure function, so the only cost of dropping it is recomputing.
      this.cache.clear();
    }
    this.cache.set(absPath, decided);
    return decided;
  }

  /**
   * Which rule excluded it, for a message or a log line.
   *
   * Takes `isDirectory` where {@link isIgnored} does not: a directory-only rule
   * such as `build/` matches the folder itself, and the command that offers to
   * add a rule has to know that the folder is already covered. `isIgnored` is on
   * the per-edit path, where every path is a file and where the answer is
   * memoised by path alone.
   */
  match(absPath: string, isDirectory = false): IgnoreMatch | undefined {
    return this.rules().match(this.workspaceRoot, absPath, isDirectory);
  }

  /** How many patterns are in force, across every enabled source. */
  patternCount(): number {
    return this.rules().size;
  }

  ignoreFilePath(): string {
    return path.join(this.workspaceRoot, IGNORE_FILE_NAME);
  }

  /**
   * The rule that would exclude exactly this path, anchored to the root so it
   * cannot also match a same-named file elsewhere in the project.
   */
  patternFor(absPath: string, isDirectory: boolean): string | undefined {
    const rel = relativeToRoot(this.workspaceRoot, absPath);
    if (rel === undefined) {
      return undefined;
    }
    // Leading `/` anchors it; a `#`, `!` or trailing space in a filename would
    // otherwise be read as syntax, so those get their escape.
    const escaped = rel.replace(/^([#!])/, "\\$1").replace(/ $/, "\\ ");
    return `/${escaped}${isDirectory ? "/" : ""}`;
  }

  /**
   * Which of these paths a rule that has not been added yet would exclude.
   *
   * The confirmation before adding a rule has to name the files it will take
   * out of the review queue, and the only trustworthy way to work that out is to
   * ask the same matcher that will enforce it a moment later.
   */
  matching(pattern: string, candidates: string[]): string[] {
    const prospective = compileIgnore([
      { label: "new rule", patterns: [pattern] },
    ]);
    return candidates.filter((p) => prospective.ignores(this.workspaceRoot, p));
  }

  // --- mutations -----------------------------------------------------------

  /**
   * Open the ignore file, creating it from the commented template first when it
   * does not exist. An empty buffer would not say what the syntax is.
   */
  async openIgnoreFile(): Promise<void> {
    const file = this.ignoreFilePath();
    if (!fileExists(file) && !atomicWrite(file, IGNORE_FILE_TEMPLATE)) {
      void vscode.window.showErrorMessage(
        `Could not create ${IGNORE_FILE_NAME} in the workspace root (check permissions).`
      );
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc);
  }

  /**
   * Append a rule to the ignore file.
   *
   * Written through the workspace edit API rather than straight to disk so the
   * addition lands on the editor's undo stack when the file is open, exactly
   * like every other write this extension makes to the user's files.
   */
  async addPattern(pattern: string): Promise<boolean> {
    const file = this.ignoreFilePath();
    const existing = readFileSafe(file);
    if (existing === undefined && !atomicWrite(file, IGNORE_FILE_TEMPLATE)) {
      this.log(`could not create ${file}`);
      return false;
    }
    const before = existing ?? IGNORE_FILE_TEMPLATE;
    if (
      parseIgnoreFile(before).some((line) => line.trim() === pattern.trim())
    ) {
      this.log(`${pattern} is already in ${IGNORE_FILE_NAME}`);
      return true;
    }
    const separator = before === "" || before.endsWith("\n") ? "" : "\n";
    try {
      const uri = vscode.Uri.file(file);
      const doc = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(
        uri,
        doc.lineAt(doc.lineCount - 1).range.end,
        `${separator}${pattern}\n`
      );
      if (!(await vscode.workspace.applyEdit(edit))) {
        return false;
      }
      if (doc.isDirty && !(await doc.save())) {
        return false;
      }
    } catch (err) {
      this.log(`could not add ${pattern} to ${file}: ${String(err)}`);
      return false;
    }
    // The file watcher will fire too, but only after VS Code notices the write;
    // invalidating here means the caller can act on the new rule immediately.
    this.invalidate(`added ${pattern} to ${IGNORE_FILE_NAME}`);
    return true;
  }

  // --- internals -----------------------------------------------------------

  private rules(): IgnoreRules {
    if (!this.compiled) {
      this.compiled = compileIgnore(this.sources());
    }
    return this.compiled;
  }

  private sources(): IgnoreSource[] {
    const sources: IgnoreSource[] = [];
    for (const source of this.sourceSpecs()) {
      if (source.patterns) {
        sources.push({ label: source.label, patterns: source.patterns });
        continue;
      }
      const text = source.file
        ? readFileSafe(path.join(this.workspaceRoot, source.file))
        : undefined;
      sources.push({
        label: source.label,
        patterns: text === undefined ? [] : parseIgnoreFile(text),
      });
    }
    return sources;
  }

  /**
   * The ordered sources, in the shape the hook descriptor uses. Both consumers
   * are built from this one list so the two processes cannot drift.
   */
  private sourceSpecs(): HookSource[] {
    const sources: HookSource[] = [];
    if (useIgnoreDefaults()) {
      sources.push({
        label: "built-in defaults",
        patterns: [...DEFAULT_IGNORE_PATTERNS],
      });
    }
    if (useGitignore()) {
      // The repository root only. Per-directory `.gitignore` files further down
      // the tree carry rules that are relative to *their* directory, and
      // pretending to honour them while quietly applying them from the root
      // would be worse than not offering the option at all.
      sources.push({ label: ".gitignore", file: ".gitignore" });
      sources.push({
        label: ".git/info/exclude",
        file: path.join(".git", "info", "exclude"),
      });
    }
    const configured = ignorePatterns();
    if (configured.length > 0) {
      sources.push({ label: "settings", patterns: configured });
    }
    if (useIgnoreFile()) {
      sources.push({ label: IGNORE_FILE_NAME, file: IGNORE_FILE_NAME });
    }
    return sources;
  }

  private invalidate(reason: string): void {
    this.compiled = undefined;
    this.cache.clear();
    this.writeHookDescriptor();
    this.log(`ignore rules reloaded: ${reason} (${this.patternCount()} rules)`);
    this._onDidChange.fire();
  }

  /**
   * Publish the rules for the hook process.
   *
   * Rewritten only when the content actually changes: this runs on every
   * configuration event, and an unchanged rewrite would be pure disk churn.
   */
  private writeHookDescriptor(): void {
    const descriptor: HookDescriptor = {
      version: 1,
      root: this.workspaceRoot,
      caseSensitive: process.platform === "linux",
      sources: this.sourceSpecs(),
    };
    const text = `${JSON.stringify(descriptor, null, 2)}\n`;
    if (text === this.lastDescriptor) {
      return;
    }
    if (atomicWrite(path.join(this.stateDir, HOOK_IGNORE_FILE), text)) {
      this.lastDescriptor = text;
    } else {
      this.log(`could not write ${HOOK_IGNORE_FILE} for the hook`);
    }
  }
}
