/**
 * The single description of every setting this extension contributes.
 *
 * `package.json` declares the same keys for the native Settings editor, the
 * webview panel renders its controls from here, and a unit test asserts the two
 * agree — so a setting can never be added, renamed or re-defaulted in one place
 * only. Deliberately free of any `vscode` import: the unit tests run in plain
 * Node, where that module does not exist.
 */

export const SECTION = "claudeKeepUndo";

export type SettingValue = string | boolean | string[];

export interface SettingChoice {
  value: string;
  /** Short label for the radio button in the panel. */
  label: string;
  /** One sentence of what choosing this actually does. */
  detail: string;
}

export interface SettingSpec {
  /** Key without the `claudeKeepUndo.` prefix. */
  key: string;
  /** Sentence-case title, shown in the panel. */
  title: string;
  /** The explanation the panel shows under the title. */
  detail: string;
  /** `list` is an array of strings, rendered as one entry per line. */
  type: "enum" | "boolean" | "string" | "list";
  default: SettingValue;
  choices?: SettingChoice[];
  /** For `type: "string"`, the manifest's maxLength. */
  maxLength?: number;
  /** Shown in the panel when the value is the non-obvious one. */
  note?: string;
  /**
   * A command offered next to the control, for a setting whose real subject is
   * a file rather than a value.
   */
  action?: { command: string; label: string };
}

export interface SettingGroup {
  id: string;
  title: string;
  blurb: string;
  settings: SettingSpec[];
}

export const SETTING_GROUPS: SettingGroup[] = [
  {
    id: "surfaces",
    title: "Review surfaces",
    blurb:
      "Where Claude's changes appear while you review them. Every surface below hosts the same two actions — Keep and Undo — so turning one off never takes an action away, only a place to reach it from.",
    settings: [
      {
        key: "inlineReview",
        title: "In the file itself",
        detail:
          "How changes are marked inside the file you are editing. The gutter bars are the lightest option: click one and VS Code's Quick Diff widget opens over the line with the original text and the Keep / Undo buttons.",
        type: "enum",
        default: "quickDiff",
        choices: [
          {
            value: "quickDiff",
            label: "Gutter bars + Quick Diff widget",
            detail:
              "Coloured bars in the gutter; clicking one opens the Quick Diff widget with Keep / Undo in its toolbar.",
          },
          {
            value: "comments",
            label: "Inline comment threads",
            detail:
              "A widget between the lines at each change, showing removed and added lines with Keep / Undo in its toolbar. Heavier, but unaffected by Git's own gutter bars.",
          },
          {
            value: "both",
            label: "Both",
            detail: "Gutter bars and comment threads at the same time.",
          },
          {
            value: "off",
            label: "Nothing in the file",
            detail:
              "Review from the diff view, the changes view and the Quick Fix menu only.",
          },
        ],
        note: "In a Git repository the gutter shows Git's bars next to ours — same lines, two providers. Switch to comment threads if that bothers you.",
      },
      {
        key: "codeLens",
        title: "Keep / Undo CodeLens rows",
        detail:
          "The clickable 'Keep · Undo' rows rendered above each change. Every row pushes a line of code down, so by default they are shown only inside the diff editor, where there is nothing else competing for the space.",
        type: "enum",
        default: "diffOnly",
        choices: [
          {
            value: "diffOnly",
            label: "Only in the diff editor",
            detail:
              "The ordinary editor stays clean; open the diff to get a row above every change.",
          },
          {
            value: "always",
            label: "In every editor",
            detail:
              "Also above every change in the normal editor. On a file with many small changes this can displace a lot of code.",
          },
          {
            value: "off",
            label: "Never",
            detail:
              "No CodeLens anywhere. Keep / Undo remain on Ctrl+. , in the gutter widget and in the changes view.",
          },
        ],
      },
      {
        key: "codeLensStyle",
        title: "CodeLens wording",
        detail:
          "Extensions cannot colour or bold a CodeLens, so the only way to make one louder is an emoji. Plain text matches every other lens in the editor; the emoji stands out but ignores your colour theme.",
        type: "enum",
        default: "text",
        choices: [
          {
            value: "text",
            label: "Plain text — Keep · Undo",
            detail: "Reads like the reference and implementation lenses.",
          },
          {
            value: "emoji",
            label: "Emoji — ✅ Keep · ❌ Undo",
            detail: "Louder and easier to hit, at the cost of theme fidelity.",
          },
        ],
      },
      {
        key: "quickFixes",
        title: "Quick Fix actions (Ctrl+. / Cmd+.)",
        detail:
          "Keep and Undo offered in the lightbulb menu. They only ever appear when the cursor is inside one of Claude's changes, so an unrelated Quick Fix elsewhere in the file is never mixed with them.",
        type: "enum",
        default: "hunkAndFile",
        choices: [
          {
            value: "hunkAndFile",
            label: "This change and the whole file",
            detail:
              "Four entries: Keep / Undo this change, and Keep / Undo every change in the file.",
          },
          {
            value: "hunkOnly",
            label: "Only this change",
            detail:
              "Two entries. The whole-file actions stay in the editor title bar and the changes view.",
          },
          {
            value: "off",
            label: "None",
            detail: "Nothing from this extension in the lightbulb menu.",
          },
        ],
      },
      {
        key: "diffMode",
        title: "Diff layout",
        detail:
          "How the diff of a file Claude changed is laid out. VS Code has no per-editor diff layout, so while a Claude diff is open the extension borrows the global setting and puts your value back when you leave the tab.",
        type: "enum",
        default: "inline",
        choices: [
          {
            value: "inline",
            label: "Single pane (unified)",
            detail: "Old and new lines stacked in one editor, no split.",
          },
          {
            value: "sideBySide",
            label: "Side by side",
            detail: "The original on the left, Claude's version on the right.",
          },
        ],
      },
      {
        key: "autoOpenDiff",
        title: "Open the diff automatically",
        detail:
          "Open the diff tab as soon as Claude modifies a file, instead of waiting for you to click. Useful when you watch Claude work; disruptive when it edits many files in a row.",
        type: "boolean",
        default: false,
      },
    ],
  },
  {
    id: "queue",
    title: "Pending queue",
    blurb:
      "Ambient signals that changes are waiting for you. These do not add actions — they tell you there is something to review when you are looking somewhere else.",
    settings: [
      {
        key: "viewBadge",
        title: "Count on the changes view",
        detail:
          "A number on the 'Claude: Changes to Review' section header in the Explorer, so a collapsed section still tells you how many files are queued.",
        type: "boolean",
        default: true,
      },
      {
        key: "statusBar",
        title: "Status bar item",
        detail:
          "A small entry in the status bar showing how many files are waiting. Clicking it opens all pending changes in one multi-file diff.",
        type: "enum",
        default: "whenPending",
        choices: [
          {
            value: "whenPending",
            label: "Only when something is pending",
            detail: "Appears at one file, disappears at zero.",
          },
          {
            value: "always",
            label: "Always",
            detail:
              "Stays visible and reads 'No Claude changes' when the queue is empty.",
          },
          { value: "off", label: "Never", detail: "No status bar entry." },
        ],
      },
      {
        key: "explorerBadge",
        title: "Explorer badge",
        detail:
          "The symbol and colour on files Claude has modified. Propagating it to parent folders helps find a change in a collapsed tree, but with any change anywhere the workspace root ends up permanently marked.",
        type: "enum",
        default: "file",
        choices: [
          {
            value: "file",
            label: "On the file only",
            detail: "The modified file is marked; folders stay untouched.",
          },
          {
            value: "fileAndFolders",
            label: "On the file and its folders",
            detail:
              "Every parent folder up to the workspace root is marked too.",
          },
          {
            value: "off",
            label: "No badge",
            detail: "Nothing in the Explorer.",
          },
        ],
      },
      {
        key: "badge",
        title: "Badge symbol",
        detail:
          "The character drawn next to a modified file. At most two are shown. The default echoes the burst in the Claude logo; ❋ ✺ ✶ ✷ ❂ are similar.",
        type: "string",
        default: "✳",
        maxLength: 8,
      },
      {
        key: "sourceControlList",
        title: "List the files in the Source Control view",
        detail:
          "A 'Claude Changes' section in the Source Control view listing the pending files, next to Git's. Turning this off leaves the gutter bars working — they are provided by the same registration.",
        type: "boolean",
        default: true,
      },
      {
        key: "explorerContextMenu",
        title: "Explorer right-click entry",
        detail:
          "Adds 'Open Diff of Claude's Changes' to the Explorer context menu. It is hidden automatically whenever nothing is pending, so it never appears on a file it cannot act on.",
        type: "boolean",
        default: true,
      },
    ],
  },
  {
    id: "safety",
    title: "Safety and feedback",
    blurb:
      "Undo rewrites a file on disk. A copy is always saved first — these settings decide how much you are told about it, before and after.",
    settings: [
      {
        key: "confirmUndo",
        title: "Confirm before undoing",
        detail:
          "Deleting a file Claude created is always confirmed, whatever this is set to: that outcome is heavier than rewriting one, and it cannot be inferred from the click.",
        type: "enum",
        default: "risky",
        choices: [
          {
            value: "risky",
            label: "Only when your own work is at risk",
            detail:
              "Asks when you have edited the file yourself since Claude did, and for Undo All. A single click on an untouched file goes straight through.",
          },
          {
            value: "always",
            label: "Every time",
            detail: "A dialog before every Undo, including single changes.",
          },
          {
            value: "never",
            label: "Never (except deletions)",
            detail:
              "No dialogs. The recovery snapshot and Ctrl+Z remain your safety net.",
          },
        ],
      },
      {
        key: "feedback.undoNotification",
        title: "Offer to restore after an Undo",
        detail:
          "A notification after each Undo with a Restore button that puts the file back exactly as Claude left it, still under review. This is what makes the automatic recovery snapshot visible at the moment you might need it.",
        type: "boolean",
        default: true,
      },
      {
        key: "feedback.statusBarMessage",
        title: "Confirm actions in the status bar",
        detail:
          "A short message such as 'Kept 3 lines in auth.ts' for a few seconds after Keep or Undo. Nothing to dismiss — from the Quick Fix menu there is otherwise no sign that anything happened.",
        type: "boolean",
        default: true,
      },
    ],
  },
  {
    id: "detection",
    title: "Detection",
    blurb:
      "How the extension learns what Claude changed. The hooks give exact baselines; the transcript reader is a zero-config fallback that cannot reconstruct every edit.",
    settings: [
      {
        key: "detection.useHooks",
        title: "Use Claude Code hooks",
        detail:
          "Reads Claude's edits through the PreToolUse / PostToolUse hooks, which capture the file exactly as it was before the edit. Requires installing the hooks in the project.",
        type: "boolean",
        default: true,
      },
      {
        key: "detection.useTranscript",
        title: "Use the session transcript",
        detail:
          "Reconstructs edits from the Claude Code session log in ~/.claude/projects. Needs no setup, but an edit whose original state cannot be reconstructed exactly is listed as not reviewable rather than guessed at.",
        type: "boolean",
        default: true,
      },
      {
        key: "promptToInstallHooks",
        title: "Offer to install the hooks on startup",
        detail:
          "Asks once per project when the hooks are missing. Declining is remembered for that project.",
        type: "boolean",
        default: true,
      },
      {
        key: "trackOutsideWorkspace",
        title: "Review files outside the open folder",
        detail:
          "Claude routinely edits files outside your project — its own settings, scratch files, a sibling repository. Off by default: those files cannot be shown in the Explorer, and their baselines would be copied into this workspace's storage.",
        type: "boolean",
        default: false,
      },
    ],
  },
  {
    id: "ignore",
    title: "Ignored files",
    blurb:
      "Paths the extension leaves alone entirely. An ignored file is never detected, never queued and never copied into the extension's storage — which is the point for anything holding a secret, and the difference between this and simply hiding a row.",
    settings: [
      {
        key: "ignore.useIgnoreFile",
        title: "Read .keepundoignore",
        detail:
          "A file in the workspace root, with the same syntax as .gitignore: one pattern per line, a trailing '/' for a directory, '!' to re-include, and the last matching line wins. It is committed with the project, so the whole team gets the same rules.",
        type: "boolean",
        default: true,
        action: {
          command: "claudeKeepUndo.editIgnoreFile",
          label: "Open .keepundoignore",
        },
      },
      {
        key: "ignore.patterns",
        title: "Additional patterns",
        detail:
          "The same syntax, kept in your settings instead of in the project — for rules that are yours rather than the team's. One pattern per line. These are applied before .keepundoignore, so a rule in that file has the final word.",
        type: "list",
        default: [],
      },
      {
        key: "ignore.useDefaults",
        title: "Ignore .git and node_modules",
        detail:
          "The two directories that are never reviewed by hand: an `npm install` Claude runs for you would otherwise queue thousands of files, and a baseline of a git index is not text anyone reads.",
        type: "boolean",
        default: true,
      },
      {
        key: "ignore.useGitignore",
        title: "Also apply .gitignore",
        detail:
          "Adds the rules from the repository's own .gitignore and .git/info/exclude. Off by default because build output you do not commit is still output you may want to see Claude change.",
        type: "boolean",
        default: false,
        note: "Only the .gitignore in the workspace root is read. Per-directory .gitignore files further down the tree carry rules relative to their own directory, and applying those from the root would exclude the wrong files.",
      },
    ],
  },
];

export interface Preset {
  id: string;
  label: string;
  blurb: string;
  values: Record<string, SettingValue>;
}

/**
 * Coherent compositions of the surface settings, so the panel can offer a whole
 * review experience instead of eleven independent switches. Only surfaces are
 * touched: detection and safety are never changed behind the user's back.
 */
export const PRESETS: Preset[] = [
  {
    id: "minimal",
    label: "Minimal",
    blurb:
      "Gutter bars and the changes view. Nothing is drawn between your lines and nothing is added to the lightbulb menu.",
    values: {
      inlineReview: "quickDiff",
      codeLens: "off",
      quickFixes: "hunkOnly",
      explorerBadge: "file",
      statusBar: "whenPending",
      viewBadge: true,
      sourceControlList: false,
      autoOpenDiff: false,
    },
  },
  {
    id: "recommended",
    label: "Recommended",
    blurb:
      "The default. Gutter bars in the file, CodeLens inside the diff where there is room for it, and the queue visible in the Explorer and the status bar.",
    values: {
      inlineReview: "quickDiff",
      codeLens: "diffOnly",
      codeLensStyle: "text",
      quickFixes: "hunkAndFile",
      explorerBadge: "file",
      statusBar: "whenPending",
      viewBadge: true,
      sourceControlList: true,
      autoOpenDiff: false,
    },
  },
  {
    id: "everything",
    label: "Everything",
    blurb:
      "Every surface at once, for a small project or a first look at what the extension can show you. Expect a busy editor.",
    values: {
      inlineReview: "both",
      codeLens: "always",
      codeLensStyle: "emoji",
      quickFixes: "hunkAndFile",
      explorerBadge: "fileAndFolders",
      statusBar: "always",
      viewBadge: true,
      sourceControlList: true,
      autoOpenDiff: true,
    },
  },
];

/** Every spec, flattened, in the order the panel renders them. */
export function allSettings(): SettingSpec[] {
  return SETTING_GROUPS.flatMap((g) => g.settings);
}

export function findSetting(key: string): SettingSpec | undefined {
  return allSettings().find((s) => s.key === key);
}
