import * as vscode from "vscode";
import { SECTION, SettingValue, findSetting } from "./settingsSchema";

export { SECTION } from "./settingsSchema";

/**
 * Typed readers for every setting.
 *
 * Each one reads the live configuration rather than a cached snapshot, so a
 * change takes effect on the next render without anything having to be
 * invalidated. Defaults come from {@link findSetting}, which is the same table
 * `package.json` is checked against — so a default can never drift between the
 * manifest and the code that reads it.
 */

function raw<T extends SettingValue>(key: string): T {
  // The `?? ""` is unreachable while the schema test passes; it is here so a
  // typo cannot produce `undefined` at a call site typed as non-optional.
  const fallback = (findSetting(key)?.default ?? "") as T;
  return vscode.workspace.getConfiguration(SECTION).get<T>(key, fallback);
}

/** Read an enum setting, falling back to its default on an unknown value. */
function choice<T extends string>(key: string, allowed: readonly T[]): T {
  const value = raw<string>(key);
  const fallback = findSetting(key)?.default as T;
  return (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export type InlineReview = "quickDiff" | "comments" | "both" | "off";
export type CodeLensMode = "always" | "diffOnly" | "off";
export type CodeLensStyle = "text" | "emoji";
export type QuickFixMode = "hunkAndFile" | "hunkOnly" | "off";
export type ExplorerBadgeMode = "file" | "fileAndFolders" | "off";
export type StatusBarMode = "whenPending" | "always" | "off";
export type ConfirmUndoMode = "risky" | "always" | "never";
export type DiffMode = "inline" | "sideBySide";

export function inlineReview(): InlineReview {
  return choice<InlineReview>("inlineReview", [
    "quickDiff",
    "comments",
    "both",
    "off",
  ]);
}

/** Does the in-file review draw gutter bars (and therefore the Quick Diff widget)? */
export function wantsGutterBars(): boolean {
  const mode = inlineReview();
  return mode === "quickDiff" || mode === "both";
}

/** Does the in-file review draw comment threads? */
export function wantsCommentThreads(): boolean {
  const mode = inlineReview();
  return mode === "comments" || mode === "both";
}

export function codeLensMode(): CodeLensMode {
  return choice<CodeLensMode>("codeLens", ["always", "diffOnly", "off"]);
}

export function codeLensStyle(): CodeLensStyle {
  return choice<CodeLensStyle>("codeLensStyle", ["text", "emoji"]);
}

export function quickFixMode(): QuickFixMode {
  return choice<QuickFixMode>("quickFixes", ["hunkAndFile", "hunkOnly", "off"]);
}

export function diffMode(): DiffMode {
  return choice<DiffMode>("diffMode", ["inline", "sideBySide"]);
}

export function autoOpenDiff(): boolean {
  return raw<boolean>("autoOpenDiff");
}

export function explorerBadgeMode(): ExplorerBadgeMode {
  return choice<ExplorerBadgeMode>("explorerBadge", [
    "file",
    "fileAndFolders",
    "off",
  ]);
}

export function badgeGlyph(): string {
  const configured = raw<string>("badge");
  // Slice by code point: `slice(0, 2)` on a two-emoji badge cuts a surrogate
  // pair in half and yields an invalid string.
  return [...(configured || "✳")].slice(0, 2).join("");
}

export function statusBarMode(): StatusBarMode {
  return choice<StatusBarMode>("statusBar", ["whenPending", "always", "off"]);
}

export function viewBadge(): boolean {
  return raw<boolean>("viewBadge");
}

export function sourceControlList(): boolean {
  return raw<boolean>("sourceControlList");
}

export function explorerContextMenu(): boolean {
  return raw<boolean>("explorerContextMenu");
}

export function confirmUndo(): ConfirmUndoMode {
  return choice<ConfirmUndoMode>("confirmUndo", ["risky", "always", "never"]);
}

export function undoNotification(): boolean {
  return raw<boolean>("feedback.undoNotification");
}

export function statusBarMessage(): boolean {
  return raw<boolean>("feedback.statusBarMessage");
}

export function useHooks(): boolean {
  return raw<boolean>("detection.useHooks");
}

export function useTranscript(): boolean {
  return raw<boolean>("detection.useTranscript");
}

export function promptToInstallHooks(): boolean {
  return raw<boolean>("promptToInstallHooks");
}

export function trackOutsideWorkspace(): boolean {
  return raw<boolean>("trackOutsideWorkspace");
}

/** Write a setting, from the panel or from a preset. */
export async function write(
  key: string,
  value: SettingValue | undefined,
  target: vscode.ConfigurationTarget
): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update(key, value, target);
}

/** Whether an event touches any key this extension owns. */
export function affectsUs(e: vscode.ConfigurationChangeEvent): boolean {
  return e.affectsConfiguration(SECTION);
}
