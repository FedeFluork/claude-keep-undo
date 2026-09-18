import * as cp from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import {
  SECTION,
  bashChanges,
  promptToInstallHooks,
  useHooks,
} from "../settings";
import { atomicWrite, readFileResult, removeFile } from "../util";
import {
  BashFolderProbe,
  BashUnavailable,
  planBashDetection,
} from "./bashAvailability";
import { BashMode } from "./bashSnapshot";
import {
  hasOurHooks,
  hookCommand,
  HookState,
  inspectHooks,
  matcherFor,
  mergeHooks,
  ourMatchers,
  stripHooks,
} from "./hookSettings";

export type { BashFolderProbe, BashUnavailable } from "./bashAvailability";
export { planBashDetection } from "./bashAvailability";
export { HookState } from "./hookSettings";

/**
 * Hooks go into `settings.local.json`, not `settings.json`.
 *
 * The command contains absolute, machine-specific paths (this extension's
 * install directory and the per-workspace state directory), and
 * `.claude/settings.json` is the *shared* file people commit. `settings.local.json`
 * is Claude Code's documented place for personal, machine-local settings and is
 * gitignored by its own convention.
 */
function localSettingsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".claude", "settings.local.json");
}

/** The shared file — read only, and only to migrate an older install out of it. */
function sharedSettingsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".claude", "settings.json");
}

type SettingsRead =
  | { kind: "missing" }
  | { kind: "ok"; value: Record<string, unknown>; raw: string }
  | { kind: "invalid"; raw: string };

/**
 * Read a settings file, keeping "there is no file" and "the file is there but
 * unparseable" apart.
 *
 * Collapsing them is what turns a stray trailing comma into a wiped Claude Code
 * configuration: the installer would see `{}`, merge our two hooks into it, and
 * write the result over the user's permissions, env and MCP servers.
 */
function readSettingsFile(file: string): SettingsRead {
  const result = readFileResult(file);
  if (result.kind === "missing") {
    return { kind: "missing" };
  }
  if (result.kind === "error") {
    return { kind: "invalid", raw: "" };
  }
  if (result.text.trim() === "") {
    return { kind: "missing" };
  }
  try {
    const parsed: unknown = JSON.parse(result.text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        kind: "ok",
        value: parsed as Record<string, unknown>,
        raw: result.text,
      };
    }
    return { kind: "invalid", raw: result.text };
  } catch {
    return { kind: "invalid", raw: result.text };
  }
}

/**
 * What is currently wired into this workspace's settings, and which file says so.
 *
 * The file matters for the messages: a hook registration can live in either
 * `.claude/settings.local.json` or the shared `.claude/settings.json`, and the
 * `foreign` warning used to offer "Open settings file" pointing unconditionally at
 * the shared one — which usually does not exist at all, so the button did nothing.
 */
function inspectRegistration(
  workspaceRoot: string,
  extensionPath: string,
  stateDir: string,
  bash: BashMode
): { state: HookState; file: string; matchers: string[] } {
  const localFile = localSettingsPath(workspaceRoot);
  const local = readSettingsFile(localFile);
  if (local.kind === "ok" && hasOurHooks(local.value)) {
    return {
      state: inspectHooks(
        local.value,
        extensionPath,
        stateDir,
        workspaceRoot,
        bash
      ),
      file: localFile,
      matchers: ourMatchers(local.value),
    };
  }
  // An install made by a pre-0.2.0 release lives in the shared file. Report it
  // as stale so the repair path moves it.
  const sharedFile = sharedSettingsPath(workspaceRoot);
  const shared = readSettingsFile(sharedFile);
  if (shared.kind === "ok" && hasOurHooks(shared.value)) {
    const state = inspectHooks(
      shared.value,
      extensionPath,
      stateDir,
      workspaceRoot,
      bash
    );
    return {
      state: state === "foreign" ? "foreign" : "stale",
      file: sharedFile,
      matchers: ourMatchers(shared.value),
    };
  }
  return { state: "missing", file: localFile, matchers: [] };
}

/** What is currently wired into this workspace's settings. */
export function hooksState(
  workspaceRoot: string,
  extensionPath: string,
  stateDir: string,
  bash: BashMode
): HookState {
  return inspectRegistration(workspaceRoot, extensionPath, stateDir, bash)
    .state;
}

/**
 * Say, once per workspace, that the hooks now run on shell commands too.
 *
 * Silence is right for a path repair — the user consented to the hooks and the
 * path is an implementation detail — but this changes *which* of Claude Code's
 * actions run our script, and that is a different question. Dismissable and
 * remembered, exactly like the foreign-hook warning.
 */
function announceBashHooks(dismissals?: vscode.Memento): void {
  const KEY = "dismissedBashHookNotice";
  if (dismissals?.get<boolean>(KEY)) {
    return;
  }
  void vscode.window
    .showInformationMessage(
      "Keep / Undo now also reviews files Claude changes by running a shell command — sed, redirection, scripts, formatters.",
      "Settings",
      "Don't show again"
    )
    .then((choice) => {
      if (choice === "Settings") {
        void vscode.commands.executeCommand("claudeKeepUndo.openSettings");
      } else if (choice === "Don't show again") {
        void dismissals?.update(KEY, true);
      }
    });
}

export type InstallResult =
  { ok: true } | { ok: false; reason: string; settingsFile: string };

/**
 * Install (or update) the Pre/PostToolUse hooks, merging with whatever is
 * already there and refusing to touch a file it could not parse. Idempotent.
 */
export function installHooks(
  workspaceRoot: string,
  extensionPath: string,
  stateDir: string,
  bash: BashMode
): InstallResult {
  const file = localSettingsPath(workspaceRoot);
  const read = readSettingsFile(file);

  if (read.kind === "invalid") {
    return {
      ok: false,
      reason:
        "the existing .claude/settings.local.json is not valid JSON, so it was left untouched",
      settingsFile: file,
    };
  }

  const current = read.kind === "ok" ? read.value : {};
  if (read.kind === "ok") {
    // Keep one rollback copy of whatever was there before our first write.
    atomicWrite(`${file}.bak`, read.raw);
  }

  const merged = mergeHooks(
    current,
    extensionPath,
    stateDir,
    workspaceRoot,
    bash
  );
  if (!atomicWrite(file, `${JSON.stringify(merged, null, 2)}\n`)) {
    return {
      ok: false,
      reason: "the file could not be written (check permissions)",
      settingsFile: file,
    };
  }

  removeOurHooksFromSharedSettings(
    workspaceRoot,
    extensionPath,
    stateDir,
    bash
  );
  return { ok: true };
}

/**
 * Take our hooks out of the shared, committed `settings.json` — a pre-0.2.0
 * release put them there together with an absolute path to the user's home
 * directory. Anything the user put in that file is preserved.
 *
 * Only entries that are recognisably *ours* are removed: a `keepundo-hook.mjs`
 * that belongs to somebody else is reported by the `foreign` path and left
 * alone, never quietly deleted from a file the user commits.
 */
function removeOurHooksFromSharedSettings(
  workspaceRoot: string,
  extensionPath: string,
  stateDir: string,
  bash: BashMode,
  log?: (msg: string) => void
): boolean {
  const file = sharedSettingsPath(workspaceRoot);
  const read = readSettingsFile(file);
  if (read.kind !== "ok" || !hasOurHooks(read.value)) {
    return false;
  }
  if (
    inspectHooks(read.value, extensionPath, stateDir, workspaceRoot, bash) ===
    "foreign"
  ) {
    return false;
  }
  atomicWrite(`${file}.bak`, read.raw);
  const stripped = stripHooks(read.value);
  if (Object.keys(stripped).length === 0) {
    // The file existed only to hold our hooks.
    removeFile(file);
  } else {
    atomicWrite(file, `${JSON.stringify(stripped, null, 2)}\n`);
  }
  log?.(
    "removed a leftover hook registration from the shared .claude/settings.json"
  );
  return true;
}

/** Install and report the outcome to the user. */
export function installHooksInteractive(
  workspaceRoot: string,
  extensionPath: string,
  stateDir: string
): boolean {
  const result = installHooks(
    workspaceRoot,
    extensionPath,
    stateDir,
    bashChanges()
  );
  if (result.ok) {
    void vscode.window.showInformationMessage(
      "Claude Code hooks installed in .claude/settings.local.json. Claude's next edits will be detected in real time."
    );
    return true;
  }
  void vscode.window
    .showErrorMessage(
      `Could not install the Claude Code hooks: ${result.reason}.`,
      "Open settings file"
    )
    .then((choice) => {
      if (choice === "Open settings file") {
        void vscode.window.showTextDocument(
          vscode.Uri.file(result.settingsFile)
        );
      }
    });
  return false;
}

/**
 * VS Code installs every extension version into its own directory, so an update
 * leaves the recorded hook command pointing at a path that no longer exists.
 * Repair it silently — the user already consented to having the hooks installed.
 */
export function repairHooksIfStale(
  workspaceRoot: string,
  extensionPath: string,
  stateDir: string,
  bash: BashMode,
  log: (msg: string) => void,
  dismissals?: vscode.Memento
): HookState {
  const { state, file, matchers } = inspectRegistration(
    workspaceRoot,
    extensionPath,
    stateDir,
    bash
  );
  if (state === "stale") {
    const hadBash = matchers.some((m) => /(^|\|)Bash(\||$)/.test(m));
    const result = installHooks(workspaceRoot, extensionPath, stateDir, bash);
    log(
      result.ok
        ? "hook command was out of date and has been repaired"
        : `hook command is out of date but could not be repaired: ${result.reason}`
    );
    if (result.ok) {
      void verifyHookRuns(extensionPath, stateDir, workspaceRoot, bash, log);
      // Repairing a path is housekeeping and rightly silent. Widening *which
      // tool calls* Claude Code runs our script for is a broader consent than
      // the user gave when they accepted the hooks, so it is said once.
      if (!hadBash && /(^|\|)Bash(\||$)/.test(matcherFor(bash))) {
        announceBashHooks(dismissals);
      }
    }
    return result.ok ? "ok" : "stale";
  }
  if (state === "ok") {
    // A project half-migrated from 0.1.x can have a healthy local install *and*
    // a leftover registration in the shared file, which Claude Code then runs —
    // and fails — on every single edit. Nothing else ever cleans that up.
    removeOurHooksFromSharedSettings(
      workspaceRoot,
      extensionPath,
      stateDir,
      bash,
      log
    );
    void verifyHookRuns(extensionPath, stateDir, workspaceRoot, bash, log);
  }
  if (state === "foreign") {
    log(
      `a keepundo-hook.mjs outside this extension is registered in ${file} — not touching it`
    );
    // Dismissable, and it opens the file the registration is actually in. The
    // warning used to fire on every activation with no way to silence it, and
    // pointed at the shared settings file even when the entry was in the local
    // one — which is a file that usually does not exist, so the button did
    // nothing.
    const dismissKey = "dismissedForeignHookWarning";
    if (dismissals?.get<boolean>(dismissKey)) {
      return state;
    }
    void vscode.window
      .showWarningMessage(
        "Claude Keep/Undo: this project registers a keepundo-hook.mjs that does not belong to this extension. It was left as is — review it before trusting the hooks.",
        "Open settings file",
        "Don't warn again"
      )
      .then((choice) => {
        if (choice === "Open settings file") {
          void vscode.window.showTextDocument(vscode.Uri.file(file));
        } else if (choice === "Don't warn again") {
          void dismissals?.update(dismissKey, true);
        }
      });
  }
  return state;
}

/**
 * Ask, once, whether shell-command detection can actually run here.
 *
 * Resolved by running `git rev-parse` rather than by looking for a `.git`
 * directory: that covers a worktree, a submodule and a `.git` file, and it also
 * answers the other half of the question — whether git can be run at all.
 */
export function probeBashDetection(
  workspaceRoot: string
): Promise<BashUnavailable | undefined> {
  return new Promise((resolve) => {
    let child: cp.ChildProcess;
    try {
      child = cp.execFile(
        "git",
        ["rev-parse", "--show-toplevel"],
        { cwd: workspaceRoot, timeout: 5000, windowsHide: true },
        (error) => {
          if (!error) {
            resolve(undefined);
            return;
          }
          // ENOENT is git itself missing; anything else is git saying no.
          resolve(
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "no-git"
              : "not-a-repository"
          );
        }
      );
    } catch {
      resolve("no-git");
      return;
    }
    child.on("error", () => resolve("no-git"));
  });
}

/**
 * Tell the user when shell-command detection cannot run — and only then.
 *
 * A non-git sibling is skipped, not a reason to disable the feature for the
 * whole window. "Turn this off" writes `detection.bashChanges` at workspace
 * scope, so it is offered only when *no* folder can photograph a shell command.
 * Mixed windows get an information toast and the hook is told to skip that peer.
 */
export async function warnIfBashDetectionUnavailable(
  folders: readonly BashFolderProbe[],
  bash: BashMode,
  log: (msg: string) => void,
  dismissals?: vscode.Memento
): Promise<void> {
  if (bash === "off" || !useHooks() || folders.length === 0) {
    return; // the user asked for none of this
  }
  const plan = planBashDetection(folders);
  if (plan.kind === "all-available") {
    return;
  }
  if (plan.kind === "skip-peers") {
    const names = plan.skipped.map((folder) => folder.name).join(", ");
    log(
      `skipping shell-command detection in ${names}: not a Git repository. Shell changes in the other folders are still detected.`
    );
    const dismissKey = "dismissedBashSkipPeerWarning";
    if (dismissals?.get<boolean>(dismissKey)) {
      return;
    }
    const message =
      plan.skipped.length === 1
        ? `Claude Keep/Undo: '${plan.skipped[0].name}' is not a Git repository, so files changed by a shell command there are skipped. Detection in the other folders is unchanged.`
        : `Claude Keep/Undo: ${plan.skipped.length} folders are not Git repositories, so shell-command changes there are skipped. Detection in the other folders is unchanged.`;
    const choice = await vscode.window.showInformationMessage(
      message,
      "Don't warn again"
    );
    if (choice === "Don't warn again") {
      await dismissals?.update(dismissKey, true);
    }
    return;
  }
  const detail =
    plan.problem === "no-git"
      ? "Git is not available on the PATH"
      : folders.length === 1
        ? "this folder is not a Git repository"
        : "none of these folders is a Git repository";
  log(
    `files changed by a shell command will not be detected: ${detail}. Everything Claude changes with its edit tools is unaffected.`
  );
  const dismissKey = "dismissedBashUnavailableWarning";
  if (dismissals?.get<boolean>(dismissKey)) {
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Claude Keep/Undo: files Claude changes by running a shell command will not be detected here, because ${detail}. Edits made with its normal edit tools are unaffected.`,
    "Turn this off",
    "Don't warn again"
  );
  if (choice === "Turn this off") {
    await vscode.workspace
      .getConfiguration(SECTION)
      .update(
        "detection.bashChanges",
        "off",
        vscode.ConfigurationTarget.Workspace
      );
  } else if (choice === "Don't warn again") {
    await dismissals?.update(dismissKey, true);
  }
}

/**
 * Run the hook command once and complain if it cannot start.
 *
 * This is a smoke test, not a faithful reproduction: `cp.exec` inherits the
 * extension host's environment, and Claude Code resolves `node` from the
 * environment of the `claude` process. A *failure* here is therefore conclusive
 * and worth reporting; a success only means the command works from VS Code's
 * environment, so it is logged rather than announced.
 *
 * `inspectHooks` can only tell whether the recorded *string* is the one we would
 * write; it cannot tell whether `node` resolves in the shell Claude Code spawns
 * hooks in. Under nvm, asdf or Volta it frequently does not — that shell is not
 * a login shell and never sources the profile that puts `node` on PATH. The
 * hooks then fail on every edit, forever, while still reporting as installed.
 *
 * A payload of `{}` carries no `file_path`, so the script returns before writing
 * anything: this probes the interpreter and has no other effect.
 */
async function verifyHookRuns(
  extensionPath: string,
  stateDir: string,
  workspaceRoot: string,
  bash: BashMode,
  log: (msg: string) => void
): Promise<void> {
  const command = hookCommand(
    extensionPath,
    stateDir,
    "pre",
    workspaceRoot,
    bash
  );
  const failure = await new Promise<string | undefined>((resolve) => {
    let child: cp.ChildProcess;
    try {
      child = cp.exec(
        // windowsHide keeps this from flashing a console window on Windows:
        // Node's default is false, and exec spawns a console-subsystem cmd.exe.
        command,
        { timeout: 5000, windowsHide: true },
        (err) => resolve(err ? err.message : undefined)
      );
    } catch (err) {
      resolve(String(err));
      return;
    }
    child.stdin?.end("{}");
  });
  if (!failure) {
    log("hook command starts and exits cleanly in this environment");
    return;
  }
  log(`hook command does not run: ${failure}`);
  const choice = await vscode.window.showWarningMessage(
    "Claude Keep/Undo: the Claude Code hooks are registered but the command does not run — most often because `node` is not on the PATH of the shell that runs hooks (nvm, asdf and Volta all do this). Detection has silently fallen back to the session transcript, which cannot reconstruct every edit.",
    "Show details",
    "Dismiss"
  );
  if (choice === "Show details") {
    void vscode.commands.executeCommand("workbench.action.output.toggleOutput");
  }
}

/**
 * On activation, offer to install the hooks if they are missing in any of the
 * given projects. Honors the "promptToInstallHooks" setting and remembers a
 * per-workspace dismissal.
 */
export async function maybePromptInstall(
  context: vscode.ExtensionContext,
  targets: { workspaceRoot: string; stateDir: string }[]
): Promise<void> {
  if (!promptToInstallHooks() || !useHooks() || targets.length === 0) {
    return;
  }
  // Guarded like every other read of the registration: this one is awaited from
  // activation with no catch, so a throw here would surface as an unhandled
  // rejection rather than as a missing prompt.
  const missing: { workspaceRoot: string; stateDir: string }[] = [];
  for (const target of targets) {
    try {
      const state = hooksState(
        target.workspaceRoot,
        context.extensionPath,
        target.stateDir,
        bashChanges()
      );
      if (state === "missing") {
        missing.push(target);
      }
    } catch {
      continue;
    }
  }
  if (missing.length === 0) {
    return;
  }
  const dismissKey = "dismissedHookPrompt";
  if (context.workspaceState.get<boolean>(dismissKey)) {
    return;
  }

  const message =
    missing.length === 1
      ? "Keep / Undo for Claude Code: install the Claude Code hooks in this project? They give exact baselines; without them some of Claude's edits cannot be reconstructed and are not offered for review."
      : `Keep / Undo for Claude Code: install the Claude Code hooks in ${missing.length} projects? They give exact baselines; without them some of Claude's edits cannot be reconstructed and are not offered for review.`;

  const choice = await vscode.window.showInformationMessage(
    message,
    "Install",
    "Transcript only",
    "Don't ask again"
  );
  if (choice === "Install") {
    if (missing.length === 1) {
      installHooksInteractive(
        missing[0].workspaceRoot,
        context.extensionPath,
        missing[0].stateDir
      );
    } else {
      let failed: Extract<InstallResult, { ok: false }> | undefined;
      let ok = 0;
      for (const target of missing) {
        const result = installHooks(
          target.workspaceRoot,
          context.extensionPath,
          target.stateDir,
          bashChanges()
        );
        if (result.ok) {
          ok++;
        } else {
          failed = result;
        }
      }
      if (ok === missing.length) {
        void vscode.window.showInformationMessage(
          `Claude Code hooks installed in ${missing.length} projects. Claude's next edits will be detected in real time.`
        );
      } else if (failed) {
        void vscode.window
          .showErrorMessage(
            `Could not install the Claude Code hooks in ${
              missing.length - ok
            } of ${missing.length} projects: ${failed.reason}.`,
            "Open settings file"
          )
          .then((open) => {
            if (open === "Open settings file") {
              void vscode.window.showTextDocument(
                vscode.Uri.file(failed.settingsFile)
              );
            }
          });
      }
    }
  } else if (choice === "Don't ask again" || choice === "Transcript only") {
    await context.workspaceState.update(dismissKey, true);
  }
}
