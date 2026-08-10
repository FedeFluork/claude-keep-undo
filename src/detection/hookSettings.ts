import * as path from "path";

/**
 * Pure helpers for reading and merging the Claude Code hook configuration.
 *
 * Kept free of any `vscode` import so it can be unit tested: this code edits a
 * file the user owns and that Claude Code executes commands from, so both the
 * merge and the "is what is installed still ours?" check need to be verifiable.
 */

export const HOOK_MARKER = "keepundo-hook.mjs";
export const MATCHER = "Edit|Write|MultiEdit";

export interface HookCommand {
  type: "command";
  command: string;
}

export interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}

export type HookMode = "pre" | "post";

export function hookScriptPath(extensionPath: string): string {
  return path.join(extensionPath, "hooks", "keepundo-hook.mjs");
}

/**
 * The command written into the settings file.
 *
 * `--state` is what decides where the review state is written. It is passed
 * explicitly because Claude Code's `cwd` is not the same as the folder VS Code
 * has open whenever `claude` is launched from a subdirectory — and state written
 * under that subdirectory would be watched by nobody.
 */
export function hookCommand(
  extensionPath: string,
  stateDir: string,
  mode: HookMode,
  workspaceRoot?: string
): string {
  const root = workspaceRoot ? ` --root "${workspaceRoot}"` : "";
  return `node "${hookScriptPath(extensionPath)}" ${mode} --state "${stateDir}"${root}`;
}

/** The `…/hooks/keepundo-hook.mjs` path referenced by a hook command, if any. */
export function extractScriptPath(command: string): string | undefined {
  const quoted = command.match(/"([^"]*keepundo-hook\.mjs)"/);
  if (quoted) {
    return quoted[1];
  }
  const bare = command.match(/(\S*keepundo-hook\.mjs)/);
  return bare ? bare[1] : undefined;
}

/**
 * Every hook command mentioned anywhere in these settings.
 *
 * Total by construction. This is the first thing to touch a file the user hand
 * edits, and `?? []` only guards null and undefined — a `hooks` value that is a
 * single object rather than an array is valid JSON, is a plausible mistake, and is
 * tolerated by Claude Code itself, but it made this function throw
 * `object is not iterable`. The throw propagated out of `hooksState` and aborted
 * `activate()` part-way through, so a typo in the user's settings took the whole
 * extension — including the transcript channel, which does not depend on hooks at
 * all — down with it.
 */
function allHookCommands(settings: unknown): string[] {
  const hooks = (settings as { hooks?: Record<string, unknown> })?.hooks;
  if (!hooks || typeof hooks !== "object") {
    return [];
  }
  const out: string[] = [];
  for (const group of Object.values(hooks)) {
    for (const matcher of asMatchers(group)) {
      for (const hook of matcher.hooks) {
        if (typeof hook?.command === "string") {
          out.push(hook.command);
        }
      }
    }
  }
  return out;
}

/**
 * The well-formed matcher entries in a hook group, ignoring anything that is not
 * one. Entries with a non-array `hooks` are the user's config in a shape we do not
 * understand: they are skipped here and preserved verbatim by {@link stripHooks}.
 */
function asMatchers(group: unknown): HookMatcher[] {
  if (!Array.isArray(group)) {
    return [];
  }
  const out: HookMatcher[] = [];
  for (const entry of group) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const matcher = entry as HookMatcher;
    if (Array.isArray(matcher.hooks)) {
      out.push(matcher);
    }
  }
  return out;
}

/** Our own hook entries under one specific event, matcher preserved. */
function ourEntriesFor(settings: unknown, event: string): HookMatcher[] {
  const hooks = (settings as { hooks?: Record<string, unknown> })?.hooks;
  if (!hooks || typeof hooks !== "object") {
    return [];
  }
  const out: HookMatcher[] = [];
  for (const matcher of asMatchers(hooks[event])) {
    const ours = matcher.hooks.filter(
      (h) => typeof h?.command === "string" && h.command.includes(HOOK_MARKER)
    );
    if (ours.length > 0) {
      out.push({ ...matcher, hooks: ours });
    }
  }
  return out;
}

/** Whether these settings mention our hook script at all. */
export function hasOurHooks(settings: unknown): boolean {
  return allHookCommands(settings).some((c) => c.includes(HOOK_MARKER));
}

export type HookState =
  | "missing"
  /** Installed, current, and pointing at this build of the extension. */
  | "ok"
  /** Ours, but from a previous install path or a different state directory. */
  | "stale"
  /** A `keepundo-hook.mjs` we did not install, e.g. shipped by the repository. */
  | "foreign";

/**
 * Classify what is currently wired into the settings.
 *
 * A plain "does the file mention keepundo-hook.mjs?" check is not enough: VS Code
 * installs each extension version into its own directory, so after every update
 * the recorded command points at a path that no longer exists — and the hooks
 * silently stop firing while still looking installed.
 *
 * Neither is comparing the flat *set* of our commands against the two we would
 * write, which is what this used to do. Discarding the event key and the matcher
 * made five broken registrations indistinguishable from a correct one: both
 * commands under `PreToolUse` with no `PostToolUse`, the two swapped between
 * events, the matcher rewritten to `Bash`, either one parked under an unrelated
 * event, or a stray extra copy alongside. All were reported `ok`, so
 * `repairHooksIfStale` never repaired them and the extension logged that real-time
 * detection was active while nothing was being captured. The worst of them — both
 * under `PreToolUse` — is not merely inert: the `post` hook then runs *before* the
 * edit and promotes a baseline identical to the file on disk, so every change
 * resolves to nothing and `pending/` fills with verbatim copies of the user's
 * source.
 */
export function inspectHooks(
  settings: unknown,
  extensionPath: string,
  stateDir: string,
  workspaceRoot?: string
): HookState {
  const ours = allHookCommands(settings).filter((c) => c.includes(HOOK_MARKER));
  if (ours.length === 0) {
    return "missing";
  }
  // Ownership first, so a mis-shaped registration of somebody else's script is
  // reported as foreign rather than silently rewritten.
  for (const command of ours) {
    const script = extractScriptPath(command);
    if (!script || !isOurInstall(script, extensionPath, workspaceRoot)) {
      return "foreign";
    }
  }
  const events: [string, HookMode][] = [
    ["PreToolUse", "pre"],
    ["PostToolUse", "post"],
  ];
  let accounted = 0;
  for (const [event, mode] of events) {
    const entries = ourEntriesFor(settings, event);
    if (entries.length !== 1) {
      return "stale";
    }
    const [entry] = entries;
    if (entry.matcher !== MATCHER || entry.hooks.length !== 1) {
      return "stale";
    }
    if (
      entry.hooks[0].command !==
      hookCommand(extensionPath, stateDir, mode, workspaceRoot)
    ) {
      return "stale";
    }
    accounted += entry.hooks.length;
  }
  // A copy of ours under any other event still runs, so it is not "ok" either.
  return accounted === ours.length ? "ok" : "stale";
}

/**
 * Does this hook script belong to some install of *this* extension?
 *
 * VS Code puts every version in its own directory
 * (`<extensions>/publisher.name-1.2.3/`), so after an update the recorded
 * command points at a sibling directory rather than at the current one. That is
 * an ordinary stale path to be repaired silently — treating it as a foreign
 * script would warn the user on every single update.
 *
 * Anything that is neither under the current install nor in such a sibling is
 * genuinely somebody else's `keepundo-hook.mjs` — for instance one shipped by
 * the repository itself, which Claude Code would then execute.
 *
 * The sibling test used to require the *same* extensions root, and that made every
 * cross-build case foreign. Stable, Insiders, Cursor and a source checkout each
 * have their own root, so opening the same project in a second build classified a
 * valid registration as somebody else's script: a security-flavoured warning on
 * every activation, with no dismissal state, and — because `repairHooksIfStale`
 * refuses to touch a foreign install — hooks that were never repointed at the
 * second build's own state directory, so that window reviewed nothing at all,
 * permanently.
 *
 * Dropping the requirement altogether is not the fix; the check exists precisely
 * so that a script shipped by the repository is never trusted. The rule is "some
 * editor's extensions directory, and not this project": the install directory name
 * must match ours once version suffixes are stripped, an ancestor must look like an
 * extensions root, and nothing under the workspace qualifies however it is named.
 */
function isOurInstall(
  scriptPath: string,
  extensionPath: string,
  workspaceRoot?: string
): boolean {
  const home = path.resolve(extensionPath);
  const script = path.resolve(scriptPath);
  if (script.startsWith(home + path.sep) || script === home) {
    return true;
  }
  if (workspaceRoot !== undefined) {
    const root = path.resolve(workspaceRoot);
    if (script === root || script.startsWith(root + path.sep)) {
      return false;
    }
  }
  // .../<installDir>/hooks/keepundo-hook.mjs
  const installDir = path.dirname(path.dirname(script));
  const stem = stripVersion(path.basename(home));
  if (stem.length === 0) {
    return false;
  }
  if (!sameExtension(stem, stripVersion(path.basename(installDir)))) {
    return false;
  }
  return looksLikeExtensionsRoot(path.dirname(installDir));
}

/**
 * Whether two install-directory stems name the same extension.
 *
 * A marketplace install is `publisher.name`; a source checkout run with F5 is just
 * the folder name, usually `name`. Accepting one as a suffix of the other is what
 * lets a developer's checkout recognise — and repair — the registration left by
 * the installed build. It is safe because the caller has already established that
 * the path is under an extensions root and outside the workspace.
 */
function sameExtension(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** `~/.vscode/extensions`, `~/.vscode-insiders/extensions`, `~/.cursor/extensions`, … */
function looksLikeExtensionsRoot(dir: string): boolean {
  if (path.basename(dir) !== "extensions") {
    return false;
  }
  return /^\.(vscode|vscodium|cursor|windsurf|positron)(-|$)/.test(
    path.basename(path.dirname(dir))
  );
}

/** `publisher.name-1.2.3` -> `publisher.name` */
function stripVersion(dirName: string): string {
  return dirName.replace(/-\d+(\.\d+)*(-.*)?$/, "");
}

/**
 * Drop any previously installed entries of ours so we can re-add a fresh path.
 *
 * `keepUnknownShapes` decides the fate of an entry whose `hooks` is not an array.
 * On the *strip* path — moving an old install out of the shared, committed
 * settings file — that entry is the user's own config and is preserved verbatim;
 * deleting it, which is what the unguarded `map` used to do, silently rewrote a
 * file they had committed. On the *merge* path it is left out of the copy we
 * write, because re-emitting a shape we do not understand risks producing a file
 * Claude Code rejects wholesale.
 */
function stripOurEntries(
  matchers: unknown,
  keepUnknownShapes = false
): HookMatcher[] {
  if (!Array.isArray(matchers)) {
    return [];
  }
  const out: HookMatcher[] = [];
  for (const entry of matchers) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const matcher = entry as HookMatcher;
    if (!Array.isArray(matcher.hooks)) {
      if (keepUnknownShapes) {
        out.push(matcher);
      }
      continue;
    }
    const hooks = matcher.hooks.filter(
      (h) =>
        !(typeof h?.command === "string" && h.command.includes(HOOK_MARKER))
    );
    if (hooks.length > 0) {
      out.push({ ...matcher, hooks });
    }
  }
  return out;
}

/**
 * Add our hook to a matcher group, reusing an existing entry with the same
 * matcher instead of appending a duplicate block next to it.
 */
function withOurHook(matchers: unknown, command: string): HookMatcher[] {
  const next = stripOurEntries(matchers);
  const entry: HookCommand = { type: "command", command };
  const existing = next.find((m) => m.matcher === MATCHER);
  if (existing) {
    return next.map((m) =>
      m === existing ? { ...m, hooks: [...m.hooks, entry] } : m
    );
  }
  return [...next, { matcher: MATCHER, hooks: [entry] }];
}

/**
 * Return a copy of the settings with our Pre/PostToolUse hooks installed,
 * preserving everything else. Idempotent.
 */
export function mergeHooks(
  settings: Record<string, unknown>,
  extensionPath: string,
  stateDir: string,
  workspaceRoot?: string
): Record<string, unknown> {
  const raw = settings.hooks;
  const hooks: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  return {
    ...settings,
    hooks: {
      ...hooks,
      PreToolUse: withOurHook(
        hooks.PreToolUse ?? [],
        hookCommand(extensionPath, stateDir, "pre", workspaceRoot)
      ),
      PostToolUse: withOurHook(
        hooks.PostToolUse ?? [],
        hookCommand(extensionPath, stateDir, "post", workspaceRoot)
      ),
    },
  };
}

/**
 * Return a copy of the settings with every hook of ours removed, dropping the
 * `hooks` key entirely when nothing else is left in it. Used to move an install
 * made by an older version out of the shared, committed settings file.
 */
export function stripHooks(
  settings: Record<string, unknown>
): Record<string, unknown> {
  const raw = settings.hooks;
  const hooks: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const next: Record<string, unknown> = {};
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers)) {
      // Not a shape we understand, and therefore not ours to remove. This used to
      // vanish: `{"hooks":{"PreToolUse":{…}}}` came back as `{}`, silently
      // deleting a block out of a settings file the user had committed.
      next[event] = matchers;
      continue;
    }
    // Same reasoning one level down, for a single entry inside a valid group.
    const kept = stripOurEntries(matchers, /*keepUnknownShapes*/ true);
    if (kept.length > 0) {
      next[event] = kept;
    }
  }
  const copy = { ...settings };
  if (Object.keys(next).length > 0) {
    copy.hooks = next;
  } else {
    delete copy.hooks;
  }
  return copy;
}
