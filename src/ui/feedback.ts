import * as path from "path";
import * as vscode from "vscode";
import { ChangeStore, UndoSnapshot } from "../changeStore";
import { statusBarMessage, undoNotification } from "../settings";
import { pluralFiles } from "./format";

const CAN_RESTORE_KEY = "claudeKeepUndo.canRestoreUndo";

/**
 * How long a restore point stays offered.
 *
 * The record holds whole-file content captured before an Undo, and re-applying it
 * overwrites everything done since. Without an expiry the button sat in the view
 * title for the rest of the session: clicking it an hour later, expecting to undo
 * something recent, threw away an hour of work with no dialog. It is also dropped
 * as soon as any file it covers changes again — but a file nobody touches would
 * otherwise keep the offer alive forever.
 */
const RESTORE_TTL_MS = 5 * 60_000;

/** One Undo's restore point. Identity matters: see `undone`. */
interface UndoRecord {
  label: string;
  snapshots: UndoSnapshot[];
}

/** Why a restore point stopped being offered, so the UI can say so. */
type Dropped = "restored" | "superseded" | "expired" | "changed";

/**
 * What the user is told after an action succeeds.
 *
 * Two problems, one place. Keep and Undo were silent on success — correct for
 * the CodeLens path, where the row disappearing *is* the feedback, but from the
 * Quick Fix menu or the line-number context menu the menu simply closed and, if
 * the change was off-screen, nothing observable happened. And Undo's safety
 * story was invisible: the snapshot was written silently, and the user was told
 * about it only inside a dialog they may never have seen.
 *
 * So: a status bar message that costs nothing to ignore, and — after an Undo —
 * a notification whose Restore button puts the file back exactly as Claude left
 * it, still awaiting review. That is how VS Code handles its own
 * destructive-but-common actions, and it turns the snapshot machinery from a
 * guarantee into something you can actually reach.
 */
export class Feedback implements vscode.Disposable {
  private last: UndoRecord | undefined;
  private dropped: Dropped | undefined;
  private expiry: NodeJS.Timeout | undefined;
  private readonly listener: vscode.Disposable;

  constructor(private readonly store: ChangeStore) {
    // Invalidate the restore point once a file it covers moves again — Claude
    // editing it, the user typing in it, another review action. Re-applying then
    // would overwrite content the record knows nothing about.
    //
    // Deliberately only on a path-carrying event: the store fires with no uri for
    // every bulk refresh, including from inside `restoreUndoSnapshots` itself, so
    // reacting to those would drop the record the moment it was armed.
    this.listener = store.onDidChange((uri) => {
      if (uri && this.covers(uri.fsPath)) {
        this.forget("changed");
      }
    });
  }

  /** Confirm a Keep. */
  kept(message: string): void {
    this.flash(message);
  }

  /**
   * Confirm an Undo and remember how to reverse it.
   *
   * `snapshots` must have been captured *before* the undo ran, and stamped with
   * `store.stampPostUndo` after it landed.
   */
  undone(message: string, snapshots: UndoSnapshot[]): void {
    this.flash(message);
    const usable = snapshots.filter((s) => s.content !== undefined);
    if (usable.length === 0) {
      return;
    }
    const record: UndoRecord = { label: message, snapshots: usable };
    this.arm(record);
    if (!undoNotification()) {
      return;
    }
    void vscode.window
      .showInformationMessage(message, "Restore")
      .then((choice) => {
        if (choice === "Restore") {
          // The record is captured here, not read from `this.last` at click time.
          // Older notifications stay live in the Notification Center with their own
          // text and their own button, so a click on "Undid 1 change in fileA.ts"
          // used to restore whatever had been undone most recently instead.
          void this.restore(record);
        }
      });
  }

  canRestore(): boolean {
    return this.last !== undefined;
  }

  /** Does the pending restore point cover this file? */
  covers(absPath: string): boolean {
    return this.last?.snapshots.some((s) => s.path === absPath) === true;
  }

  /** Put an Undo back, content and review state together. */
  async restore(record?: UndoRecord): Promise<void> {
    if (record !== undefined && record !== this.last) {
      this.explainUnavailable(record);
      return;
    }
    const target = record ?? this.last;
    if (!target) {
      void vscode.window.showInformationMessage(
        "There is no Undo to restore in this session."
      );
      return;
    }
    this.forget("restored");
    const { failed, stale } = await this.store.restoreUndoSnapshots(
      target.snapshots
    );
    if (stale.length > 0) {
      void vscode.window.showWarningMessage(
        `${pluralFiles(stale.length)} changed since that Undo (${names(stale)}), so ${
          stale.length === 1 ? "it was" : "they were"
        } left alone — restoring would have discarded the newer content. A copy of every undone file is kept: run Claude Keep/Undo: Reveal Recovery Snapshots.`
      );
    }
    if (failed.length > 0) {
      void vscode.window.showErrorMessage(
        `${pluralFiles(failed.length)} could not be restored (${names(
          failed
        )}). A copy of every undone file is kept — run Claude Keep/Undo: Reveal Recovery Snapshots.`
      );
      return;
    }
    const restored = target.snapshots.length - stale.length;
    if (restored > 0) {
      this.flash(`Restored ${pluralFiles(restored)} — awaiting review again`);
    }
  }

  /** Drop the pending restore, e.g. once its files have been reviewed again. */
  forget(reason: Dropped = "superseded"): void {
    if (this.expiry) {
      clearTimeout(this.expiry);
      this.expiry = undefined;
    }
    if (!this.last) {
      return;
    }
    this.last = undefined;
    this.dropped = reason;
    void vscode.commands.executeCommand("setContext", CAN_RESTORE_KEY, false);
  }

  private arm(record: UndoRecord): void {
    this.forget("superseded");
    this.last = record;
    this.dropped = undefined;
    void vscode.commands.executeCommand("setContext", CAN_RESTORE_KEY, true);
    this.expiry = setTimeout(() => this.forget("expired"), RESTORE_TTL_MS);
  }

  /**
   * A Restore button from a notification whose record is no longer the pending
   * one. Say which files it was about and where the bytes still are, rather than
   * "nothing to restore" while a Restore button is visible elsewhere.
   */
  private explainUnavailable(record: UndoRecord): void {
    const what = names(record.snapshots.map((s) => s.path));
    if (this.last) {
      void vscode.window.showInformationMessage(
        `That Undo of ${what} has been superseded by a later one. Use “Restore the Last Undo” for the most recent one.`
      );
      return;
    }
    const why =
      this.dropped === "restored"
        ? "it has already been restored"
        : this.dropped === "changed"
          ? "those files have changed since"
          : "it is no longer offered";
    void vscode.window.showInformationMessage(
      `That Undo of ${what} can no longer be restored from here: ${why}. A copy of every undone file is kept — run Claude Keep/Undo: Reveal Recovery Snapshots.`
    );
  }

  private flash(message: string): void {
    if (statusBarMessage()) {
      vscode.window.setStatusBarMessage(message, 4000);
    }
  }

  dispose(): void {
    this.listener.dispose();
    this.forget();
  }
}

/** `auth.ts, config.ts and 3 more` — a list that cannot grow past a dialog. */
function names(paths: string[]): string {
  const shown = paths
    .slice(0, 5)
    .map((p) => path.basename(p))
    .join(", ");
  return paths.length > 5 ? `${shown} and ${paths.length - 5} more` : shown;
}

/** `auth.ts` — the shortest name that still identifies the file. */
export function shortName(absPath: string): string {
  return path.basename(absPath);
}
