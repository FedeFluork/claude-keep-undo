import * as vscode from "vscode";
import { diffMode } from "../settings";
import { BASELINE_SCHEME } from "./diffView";

/**
 * While a Claude diff is the active (or about-to-open) tab, the controller forces
 * two diff-editor settings and restores the user's originals the moment they move
 * away:
 *
 *   - `diffEditor.renderSideBySide = false` → single-pane inline diff, no split
 *     (only when `claudeKeepUndo.diffMode` is "inline");
 *   - `diffEditor.codeLens = true` → show the per-hunk Keep/Undo CodeLens, which
 *     the diff editor hides by default — without this they are invisible inside
 *     the diff and there is no per-hunk affordance.
 *
 * VS Code offers no per-editor override for either, hence the temporary global
 * flip. Transitions are serialized so an inspect() never races an update().
 *
 * Because the override edits the user's own settings.json, it is made
 * crash-safe: the original value is persisted to globalState *before* the first
 * write, and restored on the next activation if it is still recorded. Without
 * that, a crash — or a shutdown that drops the un-awaited restore — leaves the
 * user with `renderSideBySide: false` forever, and Settings Sync propagates it.
 *
 * globalState is shared by every VS Code window on the machine, so the records
 * are keyed per window session and carry a heartbeat: a second window must be
 * able to tell a dead session's leftovers (which it should clean up) from a live
 * sibling's override (which it must not touch, and must not mistake for the
 * user's own value).
 */
export class DiffLayoutController implements vscode.Disposable {
  private readonly renderSideBySide: ManagedSetting;
  private readonly codeLens: ManagedSetting;
  private pendingOpen = false;
  private pendingTimer: NodeJS.Timeout | undefined;
  private queue: Promise<void> = Promise.resolve();
  private warnedWriteFailure = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(context: vscode.ExtensionContext) {
    // Identifies the window an override belongs to, so a record orphaned by a
    // crash is only replayed where it was made.
    const workspaceId =
      vscode.workspace.workspaceFile?.toString() ??
      vscode.workspace.workspaceFolders?.[0]?.uri.toString() ??
      "";
    const onWriteFailure = (key: string, message: string) =>
      this.reportWriteFailure(key, message);
    this.renderSideBySide = new ManagedSetting(
      "diffEditor",
      "renderSideBySide",
      context.globalState,
      workspaceId,
      vscode.env.sessionId,
      onWriteFailure
    );
    this.codeLens = new ManagedSetting(
      "diffEditor",
      "codeLens",
      context.globalState,
      workspaceId,
      vscode.env.sessionId,
      onWriteFailure
    );

    // Anything still recorded by a session that is no longer alive means that
    // session never got to restore it. Put it back before we override anything
    // ourselves — and leave a live sibling's records alone.
    this.queue = this.queue
      .then(() => this.renderSideBySide.restoreOrphaned())
      .then(() => this.codeLens.restoreOrphaned())
      .catch(() => {});

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.schedule()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.schedule()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("claudeKeepUndo.diffMode")) {
          this.schedule();
        }
        // The user may edit the two settings we borrow while we hold them.
        if (e.affectsConfiguration("diffEditor.renderSideBySide")) {
          this.queue = this.queue
            .then(() => this.renderSideBySide.noteExternalChange())
            .catch(() => {});
          // Re-sync as well: while we are *not* holding the override, another
          // window releasing it changes the effective value out from under us and
          // we may now need to apply one.
          this.schedule();
        }
        if (e.affectsConfiguration("diffEditor.codeLens")) {
          this.queue = this.queue
            .then(() => this.codeLens.noteExternalChange())
            .catch(() => {});
          this.schedule();
        }
      })
    );
    this.schedule();
  }

  /**
   * Writing the user's settings can fail — VS Code refuses to write a
   * settings.json that has syntax errors, and rejects writes to a read-only file
   * or during shutdown. Swallowing that silently left our value in their settings
   * with nothing to say so.
   */
  private reportWriteFailure(key: string, message: string): void {
    if (this.warnedWriteFailure) {
      return;
    }
    this.warnedWriteFailure = true;
    void vscode.window.showWarningMessage(
      `Claude Keep/Undo could not update \`${key}\` in your settings (${message}). It may still be holding the value this extension set for the diff editor — fix any errors in settings.json, and it will be restored automatically.`
    );
  }

  /**
   * Call right before opening a Claude diff to avoid a side-by-side flash.
   * Returns once the overrides have actually been written, so the caller can
   * await it and open the diff already inline (and with CodeLens on) instead of
   * letting VS Code render the wrong layout for a frame first.
   */
  async notifyOpening(): Promise<void> {
    this.pendingOpen = true;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
    }
    this.pendingTimer = setTimeout(() => {
      this.pendingOpen = false;
      this.schedule();
    }, 1500);
    // Apply the overrides and WAIT for the config writes to land before returning.
    this.queue = this.queue.then(() => this.sync()).catch(() => {});
    await this.queue;
  }

  /**
   * Release every override and wait for the writes to land. Called from
   * `deactivate()`, which — unlike `dispose()` — VS Code will await.
   */
  async flush(): Promise<void> {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
    this.pendingOpen = false;
    // Released independently: one shared `.catch` meant a failure releasing
    // `renderSideBySide` skipped `codeLens` entirely, leaving it overridden with
    // no further attempt to put it back.
    this.queue = this.queue
      .then(() => this.renderSideBySide.set(undefined).catch(() => {}))
      .then(() => this.codeLens.set(undefined).catch(() => {}))
      .catch(() => {});
    await this.queue;
  }

  private schedule(): void {
    this.queue = this.queue.then(() => this.sync()).catch(() => {});
  }

  private inlineWanted(): boolean {
    return diffMode() === "inline";
  }

  /**
   * Whether a Claude diff is on screen anywhere — not merely whether it is the
   * focused tab.
   *
   * This used to read `activeTabGroup.activeTab` alone, so clicking into any other
   * editor group released both overrides while the diff was still fully visible
   * beside it: the open diff reflowed from unified to split and every per-hunk
   * `Keep · Undo` row vanished, which is the only per-hunk affordance inside the
   * diff editor. Clicking back flipped it again, and each flip was a real write to
   * the user's settings.json — in the workspace-scope case, to a file that is
   * usually committed.
   *
   * `tab.isActive` is per group, so the loop below is exactly "the tabs the user
   * can see".
   */
  private claudeDiffActive(): boolean {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.isActive && this.isClaudeDiffInput(tab.input)) {
          return true;
        }
      }
    }
    return false;
  }

  private isClaudeDiffInput(input: unknown): boolean {
    if (input instanceof vscode.TabInputTextDiff) {
      return input.original.scheme === BASELINE_SCHEME;
    }
    // The Multi Diff Editor opened by *Review All Claude Changes*.
    // `TabInputTextMultiDiff` does not exist in the 1.90 typings we compile
    // against, so it is recognised structurally: without this the whole
    // multi-file review had no per-hunk affordance at all, because CodeLens
    // stayed disabled and neither the quick diff widget nor the comment threads
    // reach inside that editor.
    const multi = input as
      { textDiffs?: { original?: vscode.Uri }[] } | undefined;
    if (Array.isArray(multi?.textDiffs)) {
      return multi.textDiffs.some(
        (d) => d.original?.scheme === BASELINE_SCHEME
      );
    }
    return false;
  }

  private async sync(): Promise<void> {
    const claudeActive = this.pendingOpen || this.claudeDiffActive();
    // Inline only when the user wants it; CodeLens always while reviewing.
    await this.renderSideBySide
      .set(claudeActive && this.inlineWanted() ? false : undefined)
      .catch(() => {});
    await this.codeLens.set(claudeActive ? true : undefined).catch(() => {});
  }

  dispose(): void {
    void this.flush();
    this.renderSideBySide.dispose();
    this.codeLens.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

type Scope = "global" | "workspace" | "workspaceFolder";

interface SavedValue {
  /** Which scope we overrode, and therefore which one to put back. */
  scope?: Scope;
  had?: boolean;
  value?: boolean;
  /**
   * The workspace the record belongs to.
   *
   * The memento is globalState, so a record left behind by a crash is visible
   * to every window. A workspace-scoped record replayed in a *different*
   * workspace would write that workspace's settings.json — so a crash in one
   * project would silently edit the next project you opened.
   */
  workspace?: string;
  /**
   * The window session that made the record, and the last time that session said
   * it was still alive.
   *
   * Identity alone cannot separate a dead session from a live sibling: a second
   * window is simply a different session either way. So the holder renews `ts` on
   * a timer, and a record whose `ts` has gone stale is the only kind a newly
   * activating window is allowed to replay. Without this, opening a second window
   * yanked the override out from under an open review in the first one and then
   * raced it into leaving the override applied with no record at all.
   */
  session?: string;
  ts?: number;
  /**
   * The value we wrote, so a sweeper can check the setting still holds it before
   * putting anything back. If it does not, there is nothing to undo — only a
   * stale record to drop.
   */
  applied?: boolean;
  /** The 1.0.0 shape, still in globalState after an update. */
  hadGlobal?: boolean;
  globalValue?: boolean;
}

/** How often a holder renews its record, and when an unrenewed one is dead. */
const HEARTBEAT_MS = 20_000;
const STALE_AFTER_MS = 60_000;

function sameRecord(a: SavedValue, b: SavedValue): boolean {
  return (
    a.scope === b.scope &&
    a.had === b.had &&
    a.value === b.value &&
    a.workspace === b.workspace &&
    a.session === b.session &&
    a.ts === b.ts &&
    a.applied === b.applied
  );
}

function normalizeSaved(saved: SavedValue): {
  scope: Scope;
  had: boolean;
  value: boolean | undefined;
} {
  if (saved.scope) {
    return {
      scope: saved.scope,
      had: saved.had === true,
      value: saved.value,
    };
  }
  return {
    scope: "global",
    had: saved.hadGlobal === true,
    value: saved.globalValue,
  };
}

function targetFor(scope: Scope): vscode.ConfigurationTarget {
  switch (scope) {
    case "workspaceFolder":
      return vscode.ConfigurationTarget.WorkspaceFolder;
    case "workspace":
      return vscode.ConfigurationTarget.Workspace;
    default:
      return vscode.ConfigurationTarget.Global;
  }
}

/**
 * A single boolean setting we temporarily override: it remembers the user's
 * original value on first override and restores it on release. Writes only on an
 * actual transition so repeated sync() calls don't spam the config.
 *
 * The override is written **at the narrowest scope the user has actually set**,
 * not always globally. A global write is shadowed by a workspace or folder value
 * of the same key, so overriding globally when the user configured
 * `diffEditor.renderSideBySide` per workspace silently did nothing — and
 * `diffEditor.codeLens` stayed off, which is what makes the per-hunk Keep/Undo
 * lenses invisible inside the diff.
 *
 * The remembered value is also persisted to globalState, so a session that dies
 * before releasing can be cleaned up by the next one.
 */
class ManagedSetting implements vscode.Disposable {
  private applied = false;
  private scope: Scope = "global";
  private saved: boolean | undefined;
  private savedExisted = false;
  private current: boolean | undefined;
  private writing = false;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(
    private readonly section: string,
    private readonly key: string,
    private readonly memento: vscode.Memento,
    private readonly workspaceId: string,
    private readonly sessionId: string,
    private readonly onWriteFailure: (key: string, message: string) => void
  ) {}

  private record(): SavedValue {
    return {
      scope: this.scope,
      had: this.savedExisted,
      value: this.saved,
      workspace: this.workspaceId,
      session: this.sessionId,
      ts: Date.now(),
      applied: this.current,
    };
  }

  private get keyPrefix(): string {
    return `managedSetting:${this.section}.${this.key}:`;
  }

  private get storageKey(): string {
    return `${this.keyPrefix}${this.sessionId}`;
  }

  /** The pre-1.1.1 shape: one key per setting, shared by every window. */
  private get legacyKey(): string {
    return `managedSetting:${this.section}.${this.key}`;
  }

  /** Every record for this setting, from any session. */
  private records(): { key: string; raw: SavedValue }[] {
    const found: { key: string; raw: SavedValue }[] = [];
    for (const key of this.memento.keys()) {
      if (key !== this.legacyKey && !key.startsWith(this.keyPrefix)) {
        continue;
      }
      const raw = this.memento.get<SavedValue>(key);
      if (raw) {
        found.push({ key, raw });
      }
    }
    return found;
  }

  /**
   * Is the window that wrote this record still running?
   *
   * A record with no `ts` was written by a version that did not heartbeat, so it
   * can only be treated as dead — which is correct for the leftovers an upgrade
   * finds, and the worst it can do otherwise is release an override one time.
   */
  private isLive(raw: SavedValue): boolean {
    return typeof raw.ts === "number" && Date.now() - raw.ts < STALE_AFTER_MS;
  }

  private inspect() {
    return vscode.workspace
      .getConfiguration(this.section)
      .inspect<boolean>(this.key);
  }

  private valueAt(scope: Scope): boolean | undefined {
    const info = this.inspect();
    return scope === "workspaceFolder"
      ? info?.workspaceFolderValue
      : scope === "workspace"
        ? info?.workspaceValue
        : info?.globalValue;
  }

  /** Undo an override left behind by a session that never released it. */
  async restoreOrphaned(): Promise<void> {
    if (this.applied) {
      return;
    }
    const orphans = this.records()
      .filter((r) => r.key !== this.storageKey && !this.isLive(r.raw))
      .filter((r) => {
        const saved = normalizeSaved(r.raw);
        // Someone else's workspace. Restoring it here would edit the wrong
        // project's settings; leave the record for the window that owns it.
        return saved.scope === "global" || r.raw.workspace === this.workspaceId;
      })
      // Oldest first: it is the one that knows what the user had before any
      // window started overriding.
      .sort((a, b) => (a.raw.ts ?? 0) - (b.raw.ts ?? 0));
    if (orphans.length === 0) {
      return;
    }
    const target = orphans[0];
    const saved = normalizeSaved(target.raw);
    const held = target.raw.applied;
    if (held === undefined || this.valueAt(saved.scope) === held) {
      try {
        await this.write(saved.had ? saved.value : undefined, saved.scope);
      } catch (err) {
        this.reportFailure(err);
        return; // keep the records: the next activation should try again
      }
    }
    for (const orphan of orphans) {
      // Compare-and-swap. Deleting unconditionally is how a race with the record's
      // own holder ended with the override applied and nothing left to undo it.
      await this.clearIfUnchanged(orphan.key, orphan.raw);
    }
  }

  private async clearIfUnchanged(key: string, raw: SavedValue): Promise<void> {
    const still = this.memento.get<SavedValue>(key);
    if (still && sameRecord(still, raw)) {
      await this.memento.update(key, undefined);
    }
  }

  /**
   * A record for this setting written by a window that is still alive.
   *
   * Its `saved` is the user's actual value; the *live config* is not, because it
   * is that window's override. Reading the config instead is how the second
   * window to open a diff recorded `renderSideBySide: false` as "what the user
   * chose" and then faithfully wrote it back into their settings for good.
   */
  private liveSibling(): SavedValue | undefined {
    return this.records()
      .filter((r) => r.key !== this.storageKey && this.isLive(r.raw))
      .sort((a, b) => (a.raw.ts ?? 0) - (b.raw.ts ?? 0))[0]?.raw;
  }

  /** Pass a value to override (saving the user's original once), or undefined to restore. */
  async set(override: boolean | undefined): Promise<void> {
    if (override !== undefined) {
      if (!this.applied) {
        // Nothing to override: the effective value is already what we want, so
        // there is no write to make and no record to keep. This is also what keeps
        // two windows out of each other's way in the common case.
        const effective = vscode.workspace
          .getConfiguration(this.section)
          .get<boolean>(this.key);
        if (effective === override) {
          return;
        }
        const sibling = this.liveSibling();
        if (sibling) {
          const saved = normalizeSaved(sibling);
          this.scope = saved.scope;
          this.saved = saved.value;
          this.savedExisted = saved.had;
        } else {
          const info = this.inspect();
          // The narrowest scope that is actually set wins at read time, so that
          // is the one an override has to occupy to take effect.
          if (info?.workspaceFolderValue !== undefined) {
            this.scope = "workspaceFolder";
            this.saved = info.workspaceFolderValue;
            this.savedExisted = true;
          } else if (info?.workspaceValue !== undefined) {
            this.scope = "workspace";
            this.saved = info.workspaceValue;
            this.savedExisted = true;
          } else {
            this.scope = "global";
            this.saved = info?.globalValue;
            this.savedExisted = info?.globalValue !== undefined;
          }
        }
        // Persist before the first write: a crash between the two would
        // otherwise leave the override with no record of what to restore.
        await this.memento.update(this.storageKey, this.record());
        this.applied = true;
        this.startHeartbeat();
      }
      if (this.current !== override) {
        const previous = this.current;
        this.current = override;
        try {
          await this.write(override, this.scope);
        } catch (err) {
          this.current = previous;
          this.reportFailure(err);
          return;
        }
        // Re-record so the sweeper knows which value is on disk.
        await this.memento.update(this.storageKey, this.record());
      }
    } else if (this.applied) {
      // Write *first*, drop the state after. The other order left `applied` false
      // with the override still on disk, so the next override re-inspected the
      // config, read its own leftover value, and recorded that as the user's —
      // erasing their real setting from disk and from the record together.
      try {
        await this.write(
          this.savedExisted ? this.saved : undefined,
          this.scope
        );
      } catch (err) {
        this.reportFailure(err);
        return; // still applied, so the next sync() retries the release
      }
      this.applied = false;
      this.current = undefined;
      this.stopHeartbeat();
      await this.memento.update(this.storageKey, undefined);
    }
  }

  /**
   * The user edited this setting themselves while we were holding it overridden.
   * Adopt their value as the one to restore — otherwise the release puts back
   * whatever was there when the override started and quietly discards the change
   * they just made.
   */
  async noteExternalChange(): Promise<void> {
    if (!this.applied || this.writing) {
      return;
    }
    const observed = this.valueAt(this.scope);
    if (observed === this.current) {
      return; // our own value, echoed back
    }
    this.saved = observed;
    this.savedExisted = observed !== undefined;
    await this.memento.update(this.storageKey, this.record());
    // Re-assert the override, which their write has just clobbered.
    try {
      await this.write(this.current, this.scope);
    } catch (err) {
      this.reportFailure(err);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeat) {
      return;
    }
    this.heartbeat = setInterval(() => {
      if (this.applied) {
        void this.memento.update(this.storageKey, this.record());
      }
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private reportFailure(err: unknown): void {
    const message =
      err instanceof Error ? err.message : String(err ?? "unknown error");
    this.onWriteFailure(`${this.section}.${this.key}`, message);
  }

  private async write(value: boolean | undefined, scope: Scope): Promise<void> {
    this.writing = true;
    try {
      await vscode.workspace
        .getConfiguration(this.section)
        .update(this.key, value, targetFor(scope));
    } finally {
      this.writing = false;
    }
  }

  dispose(): void {
    this.stopHeartbeat();
  }
}
