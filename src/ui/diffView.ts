import * as path from "path";
import * as vscode from "vscode";
import { ChangeStore } from "../changeStore";
import { BASELINE_SCHEME } from "../util";

export { BASELINE_SCHEME } from "../util";

/**
 * Build the left-hand (baseline) URI for a real file path.
 *
 * Derived from `Uri.file` rather than assembled by hand so the path is
 * normalised the way VS Code expects (leading slash, drive-letter casing,
 * separator conversion) and `uri.fsPath` round-trips on every platform.
 */
export function toBaselineUri(absPath: string): vscode.Uri {
  return vscode.Uri.file(absPath).with({ scheme: BASELINE_SCHEME });
}

/** The real file path behind a baseline URI. */
export function fromBaselineUri(uri: vscode.Uri): string {
  return uri.fsPath;
}

/**
 * Serves the recorded baseline content for the left side of the diff editor.
 * Refreshes whenever a Keep folds a change into the baseline.
 */
export class BaselineContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  private readonly listener: vscode.Disposable;

  constructor(private readonly store: ChangeStore) {
    this.listener = store.onDidChange((uri) => {
      if (uri) {
        this._onDidChange.fire(toBaselineUri(uri.fsPath));
        return;
      }
      // A bulk change (a refresh, a Keep All) carries no uri. Firing for every
      // open baseline document is what keeps a diff tab from going on showing
      // the previous baseline after the hooks replaced it on disk.
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme === BASELINE_SCHEME) {
          this._onDidChange.fire(doc.uri);
        }
      }
    });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.store.getBaseline(fromBaselineUri(uri));
  }

  dispose(): void {
    this.listener.dispose();
    this._onDidChange.dispose();
  }
}

export interface OpenDiffOptions {
  /** Scroll to this 0-based line once the diff is open. */
  atLine?: number;
  /** Called before the tab opens, so the layout overrides land first. */
  onOpening?: () => void | Promise<void>;
  /**
   * The other files awaiting review. Only used to decide whether the basename
   * alone is enough to tell this tab apart from its neighbours.
   */
  siblings?: string[];
}

/**
 * Open the Claude diff for a file: baseline (left, original) vs the current
 * content (right, Claude's edits). Additions show green, deletions red — the
 * standard VS Code diff rendering — and the right side is the real, editable
 * file so Keep/Undo act directly on it.
 */
export async function openClaudeDiff(
  absPath: string,
  options: OpenDiffOptions = {}
): Promise<void> {
  const { atLine, onOpening, siblings } = options;
  const left = toBaselineUri(absPath);
  const right = vscode.Uri.file(absPath);
  await onOpening?.();

  // Pre-warm CodeLens computation so the diff opens with the Keep/Undo lenses
  // already laid out. Unlike `renderSideBySide` (a synchronous layout property),
  // VS Code computes CodeLens asynchronously after the editor mounts — so without
  // this the rows show for a beat and then reflow downward as the lenses pop in.
  // Loading the model and querying the provider up front lets the diff editor
  // pick them up from cache on first paint.
  try {
    await vscode.workspace.openTextDocument(right);
    await vscode.commands.executeCommand(
      "vscode.executeCodeLensProvider",
      right
    );
  } catch {
    /* best effort: the lenses still appear, just slightly later */
  }

  await vscode.commands.executeCommand(
    "vscode.diff",
    left,
    right,
    diffTitle(absPath, siblings),
    { preview: true } as vscode.TextDocumentShowOptions
  );

  if (atLine !== undefined) {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.fsPath === absPath) {
      const pos = new vscode.Position(Math.max(0, atLine), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenter
      );
    }
  }
}

/**
 * The tab title.
 *
 * Tabs truncate from the right, so `src/detection/transcriptWatcher.ts:
 * baseline ↔ Claude's changes` renders as `src/detect…` with three tabs open —
 * the path prefix, which is the half that does not identify the file. VS Code's
 * own convention is the basename with the distinguishing word in parentheses,
 * and the directory is only spent when two pending files share a basename.
 */
export function diffTitle(absPath: string, siblings?: string[]): string {
  const base = path.basename(absPath);
  const ambiguous = (siblings ?? []).some(
    (other) => other !== absPath && path.basename(other) === base
  );
  if (!ambiguous) {
    return `${base} (Claude)`;
  }
  const parent = path.basename(path.dirname(absPath));
  return `${base} (Claude · ${parent})`;
}
