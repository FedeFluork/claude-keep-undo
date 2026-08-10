# Keep / Undo for Claude Code — Reference

The [README](README.md) is the overview. This document is the complete
specification: every review surface, how change detection works, every setting
and command, the known limitations and why they exist, and how to build the
extension.

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Every review surface](#every-review-surface)
- [What Keep and Undo do](#what-keep-and-undo-do)
- [Undo is reversible](#undo-is-reversible)
- [How change detection works](#how-change-detection-works)
- [On-disk state](#on-disk-state)
- [Settings](#settings)
- [Commands](#commands)
- [Known limitations](#known-limitations)
- [Development](#development)
- [Privacy](#privacy)

---

## Requirements

| | |
|---|---|
| VS Code | `^1.90.0` (the Multi Diff Editor needs 1.86+; 1.90 is a deliberate safety margin) |
| Node.js | `>= 18` on your `PATH` — required by the hook script (see below) |
| Claude Code | Any version that writes session transcripts to `~/.claude/projects` and supports `PreToolUse`/`PostToolUse` hooks |

A workspace folder must be open; the extension is a no-op in an empty window.

---

## Installation

**From the Marketplace** — search for *Keep / Undo for Claude Code* in the
Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`), or:

```bash
code --install-extension FedeFluork.claude-keep-undo
```

**From a `.vsix`** — build it yourself (see [Development](#development)) and:

```bash
code --install-extension claude-keep-undo-<version>.vsix --force
```

---

## Quick start

1. Open a project where you use Claude Code.
2. On first activation the extension offers to install its Claude Code hooks.
   Accept for precise, real-time detection — or choose **Transcript only** and
   it works with zero configuration.
3. Let Claude edit some files.
4. Changed files get an `✳` badge in the Explorer, coloured bars in the editor
   gutter, and an entry under **Claude: Changes to Review**.
5. Review in place: click a gutter bar to open the inline Quick Diff widget and
   press **Keep** or **Undo** there, or put the cursor on a change and hit
   `Ctrl+.` / `Cmd+.`.
6. Prefer a diff view? Click the file in the changes view, right-click →
   *Open Diff of Claude's Changes*, or enable `claudeKeepUndo.autoOpenDiff`.
   For a bird's-eye pass, run **Review All Claude Changes (Multi-File Diff)**.
7. When you are done, Keep All / Undo All from the editor title bar, the changes
   view toolbar, or the Source Control title bar.
8. Too much on screen, or not enough? Run **Claude Keep/Undo: Settings and
   Setup** — every surface below can be turned on or off there, with three
   presets for the whole set.

---

## Every review surface

Claude Code edits files directly on disk. That is fast, but it leaves you
without the "here is what changed, accept or reject it" step you get from an
IDE-integrated assistant. This extension adds that step back.

### In the file you are editing

- **Change bars in the gutter.** Every line Claude touched gets a coloured bar
  in the real editor — no diff tab needed. Click one and VS Code's Quick Diff
  widget opens **inline, inside the file**, showing the original lines with
  **Keep** and **Undo** in its toolbar.
- **Inline change threads** *(optional)*. Set
  `claudeKeepUndo.inlineReview` to `comments` and each change becomes a widget
  rendered *between* the editor lines, showing the removed and added lines as a
  unified diff with Keep / Undo in its header.
- **Quick Fixes.** Put the cursor on a change and press `Ctrl+.` / `Cmd+.` —
  *Keep this Claude change* / *Undo this Claude change*, entirely from the
  keyboard. They appear only when the cursor is inside a change, so an unrelated
  Quick Fix elsewhere in the file is never mixed with them.
- **Line-number menu.** Right-click the line number of a change for the same two
  actions.
- **Keyboard review loop.** `Ctrl+Alt+N` / `Ctrl+Alt+P` walk to the next and
  previous change; `Ctrl+Alt+K` keeps the one under the caret, `Ctrl+Alt+U`
  undoes it. All four are scoped to files Claude has actually changed, so they
  give the keys back everywhere else.
- **Per-hunk CodeLens.** `Keep (+3 −1)` / `Undo` above each changed region, plus
  `Keep all` / `Undo all` at the top of the file — inside the diff editor by
  default, since every row displaces a line of code.

### Across the whole review queue

- **Explorer badge.** Files Claude touched are marked with `✳` and tinted with
  the Claude brand orange until you review them.
- **Status bar.** `Claude: 3 files` while anything is pending, wherever you are
  in the workbench. Click it to open everything in one diff.
- **Source Control entry.** A *Claude Changes* provider lists every pending file
  with inline Keep / Undo and a count badge.
- **Multi-file diff.** *Review All Claude Changes* opens every pending file in a
  single Multi Diff Editor tab — one scroll through everything Claude did.
- **Dedicated view.** *Claude: Changes to Review* in the Explorer lists every
  pending file with a count on its header, expandable into its individual hunks —
  each row leading with the code it changes — plus global Keep All / Undo All in
  the view toolbar.
- **Side-by-side or unified diff.** Opening a file's diff compares the
  *pre-Claude* baseline against what is on disk now, with the right-hand side
  being the real, editable file.

### Everywhere

- **Survives reloads.** State lives on disk, so closing the window or restarting
  VS Code does not lose your pending review queue.
- **Fully local.** No network calls, no telemetry, no account. Everything
  happens on your machine.
- **Stable API only.** Nothing here depends on VS Code proposed APIs, so it
  ships on the Marketplace like any other extension.

---

## What Keep and Undo do

**Keep** folds the change into the recorded baseline (the file stays as Claude
wrote it). **Undo** rewrites the file back to the baseline. Either way, once
baseline and file agree, the badge and the entry disappear.

## Undo is reversible

Undo rewrites a whole region of your file, so it is treated as a destructive
action throughout:

- **It never guesses.** A Keep or Undo whose change has moved since the button
  was drawn is refused, not applied to whatever now occupies that position. A
  baseline that cannot be established exactly is not offered for review at all.
- **It warns when your own work is at stake.** The extension cannot tell your
  lines from Claude's, so a file you have also edited is marked *edited by you*
  in the changes view, and Undo asks for confirmation naming the file.
- **It goes on the editor's undo stack.** `Ctrl+Z` / `Cmd+Z` takes an Undo back.
- **It offers the way back.** Every Undo is confirmed by a notification with a
  **Restore** button that puts the file back exactly as Claude left it — content
  *and* review state, so it is pending again rather than silently accepted.
- **It keeps a copy.** The file's content is snapshotted before every destructive
  action; run *Claude Keep/Undo: Reveal Recovery Snapshots* to find it. Snapshots
  are kept for 14 days.

---

## How change detection works

Two complementary mechanisms, both enabled by default and independently
switchable.

### 1. Claude Code hooks — precise, real-time

The extension registers `PreToolUse` and `PostToolUse` hooks matching
`Edit|Write|MultiEdit` in `<workspace>/.claude/settings.local.json`.

- **`PreToolUse`** runs *before* Claude writes. It captures the file's original
  content and stages it under `pending/`. It deliberately does **not** publish
  it as a baseline yet — at that instant the file on disk still equals the
  capture, so the extension would see "no difference" and discard it.
- **`PostToolUse`** runs *after* the write lands. It promotes the staged copy to
  a real baseline, so the extension always computes a genuine diff.

The hook script never blocks a tool call: it swallows every error and always
exits `0`.

The hooks are registered in **`.claude/settings.local.json`**, which Claude Code
treats as personal and machine-local — the command contains absolute paths that
have no business in a committed file. If the extension updates, or the workspace
moves, the recorded command is repaired silently on the next activation.

Install or re-install them any time via the command palette:
**Claude Keep/Undo: Install Claude Code Hooks in This Project**.

### 2. Session transcript — zero-config fallback

The extension tails the active session transcript at
`~/.claude/projects/<encoded-cwd>/<session>.jsonl`, extracts `Edit`, `Write` and
`MultiEdit` tool calls, and **reconstructs** the pre-Claude content by
reverse-applying those edits to the file currently on disk.

It only reacts to edits made **from the moment the extension attaches** — it does
not replay a session's earlier history, so the review queue does not flood on
startup, and resuming an older session does not replay it either.

An edit counts only once its **result** says it happened. A tool call appears in
the transcript before the tool runs, so on its own it proves nothing: Claude Code
refuses edits whose `old_string` is not found, you can deny a call at the
permission prompt, and the same record sometimes appears twice in the file.
Reverse-applying an edit that never landed produces a baseline that never existed,
so calls are matched to their `tool_result` and committed only if it reports
success — and a call whose result never arrives makes the file *not reviewable*
rather than reconstructed from the calls that did land.

Every reconstruction is then **proved**: replaying the recorded edits forward over
the candidate baseline must reproduce the file on disk byte for byte. That proof
is necessary but not sufficient, and where it cannot decide the answer the
extension refuses instead:

- a **deletion** leaves no anchor saying where the removed text was;
- an **ambiguous replacement**, where the replacement text now occurs more than
  once;
- a **`replace_all`** edit, always — whether the replacement text already existed
  elsewhere in the file is not recorded anywhere, and both readings replay forward
  to the same content, so a rename can otherwise rewrite a line you wrote
  yourself;
- a whole-file **`Write`** whose pre-write state could not be captured, or could
  not be *proved* to predate the write (the file's own modification time has to be
  older than the tool call, or the content read may be Claude's own output).

Files in any of those categories are listed with an explanation rather than shown
against a guessed baseline. **Install the hooks for exact baselines and full
coverage.**

Reading is byte-exact and never gets stuck. A single transcript line can be
larger than the read window — Claude reading a lockfile, or writing a large file,
produces one — and such a line is skipped with a note in the log rather than
re-read forever. Offsets are counted in bytes rather than in decoded characters,
so a read that begins inside a multi-byte character cannot shift the next line
out of alignment and lose it.

When hooks are installed their baseline wins: baseline registration is a no-op
if one already exists, so the transcript path only fills gaps.

## On-disk state

State lives in **VS Code's per-workspace storage**, not in your repository:

```
<VS Code workspace storage>/FedeFluork.claude-keep-undo/
├── baselines/<key>        original (pre-Claude) content, published after the edit
├── baselines/<key>.json   { path, ts } — makes each baseline self-describing
├── pending/<key>          staging area between the Pre and Post hook
├── pending/<key>.json     { path, ts } — expires a staging left by a denied edit
├── snapshots/<key>-<ts>   pre-Undo copies, so a destructive action is recoverable
└── events.ndjson          size-capped log of hook events
```

`<key>` is a truncated SHA-1 of the absolute file path. Every entry carries its
own sidecar rather than sharing an index file, because the hook process and the
extension both write here and a shared file would lose updates.

`baselines/` and `snapshots/` hold verbatim copies of your source files —
including whatever secrets those files contain. Keeping them outside the
repository is deliberate: inside it, they are one `git add -A` away from being
committed. Run *Claude Keep/Undo: Reveal Recovery Snapshots* to find them.

---

## Settings

Every surface listed above is a setting, and there are two ways to reach them.

**The setup panel.** Run **Claude Keep/Undo: Settings and Setup** (or click the
gear in the *Claude: Changes to Review* title bar). It opens a page that shows
what is currently detected, offers three presets — **Minimal**, **Recommended**,
**Everything** — and explains what each surface costs before you turn it on. It
writes ordinary VS Code settings, so nothing there is private to the panel.

**The Settings editor.** *Extensions › Keep / Undo for Claude Code*, grouped into
*Review surfaces*, *Pending queue*, *Safety and feedback* and *Detection*.

### Review surfaces

| Setting | Default | Description |
|---|---|---|
| `claudeKeepUndo.inlineReview` | `quickDiff` | In-file review: `quickDiff` (gutter bars + Quick Diff widget), `comments` (inline threads), `both`, `off` |
| `claudeKeepUndo.codeLens` | `diffOnly` | Where the `Keep · Undo` rows appear: `diffOnly`, `always`, `off` |
| `claudeKeepUndo.codeLensStyle` | `text` | `text` (`Keep`) or `emoji` (`✅ Keep`) |
| `claudeKeepUndo.quickFixes` | `hunkAndFile` | Quick Fix entries: `hunkAndFile`, `hunkOnly`, `off` — always scoped to the change under the cursor |
| `claudeKeepUndo.diffMode` | `inline` | `inline` = single unified pane; `sideBySide` = classic split |
| `claudeKeepUndo.autoOpenDiff` | `false` | Open the diff as soon as Claude modifies a file |

### Pending queue

| Setting | Default | Description |
|---|---|---|
| `claudeKeepUndo.viewBadge` | `true` | Count badge on the changes view header |
| `claudeKeepUndo.statusBar` | `whenPending` | Status bar entry: `whenPending`, `always`, `off` |
| `claudeKeepUndo.explorerBadge` | `file` | `file`, `fileAndFolders` (propagates to parents), `off` |
| `claudeKeepUndo.badge` | `✳` | Explorer badge symbol (max 2 characters) |
| `claudeKeepUndo.sourceControlList` | `true` | List pending files in the Source Control view |
| `claudeKeepUndo.explorerContextMenu` | `true` | *Open Diff* in the Explorer right-click menu (hidden when nothing is pending) |

### Safety and feedback

| Setting | Default | Description |
|---|---|---|
| `claudeKeepUndo.confirmUndo` | `risky` | `risky` (only when your own edits are at stake, and for Undo All), `always`, `never` |
| `claudeKeepUndo.feedback.undoNotification` | `true` | Notification with a **Restore** button after an Undo |
| `claudeKeepUndo.feedback.statusBarMessage` | `true` | Brief status bar confirmation after Keep / Undo |

### Detection

| Setting | Default | Description |
|---|---|---|
| `claudeKeepUndo.detection.useHooks` | `true` | Detect edits via Claude Code hooks |
| `claudeKeepUndo.detection.useTranscript` | `true` | Detect edits via the session transcript |
| `claudeKeepUndo.promptToInstallHooks` | `true` | Offer to install the hooks on startup |
| `claudeKeepUndo.trackOutsideWorkspace` | `false` | Also review files outside the open folder |

The badge color is themeable via `claudeKeepUndo.modifiedResourceForeground` in
`workbench.colorCustomizations`.

## Commands

All commands live under the **Claude Keep/Undo** category.

| Command | Where | Keys |
|---|---|---|
| Open Diff of Claude's Changes | Palette, Explorer context menu, changes view, Source Control | |
| Review All Claude Changes (Multi-File Diff) | Palette, changes view toolbar, Source Control title bar, status bar | |
| Keep / Undo This Change | Quick Diff widget toolbar, inline comment thread, Quick Fix menu, per-hunk CodeLens, changes view | |
| Keep / Undo the Change at the Cursor | Palette | `Ctrl+Alt+K` / `Ctrl+Alt+U` |
| Go to Next / Previous Claude Change | Palette | `Ctrl+Alt+N` / `Ctrl+Alt+P` |
| Keep / Undo Claude's Change on This Line | Line-number context menu | |
| Keep / Undo All Changes in This File | Editor title bar, Source Control, changes view, Quick Fix menu, palette | |
| Keep / Undo All of Claude's Changes | Changes view toolbar, Source Control title bar, palette | |
| Restore the Last Undo | Undo notification, changes view menu, palette | |
| Settings and Setup | Changes view title bar, palette | |
| Open the Getting Started Walkthrough | Palette | |
| Install Claude Code Hooks in This Project | Palette, unreviewable rows | |
| Refresh Change Status | Changes view toolbar, palette | |
| Reveal Recovery Snapshots | Changes view menu, palette | |

*Undo All* asks for confirmation before rewriting files. On macOS the four
keyboard shortcuts use `Cmd` instead of `Ctrl`, and all of them apply only while
the active editor holds a file Claude has changed.

---

## Known limitations

These are honest constraints of VS Code's **stable** extension API. Anything
that requires a *proposed* API is deliberately not used, because extensions that
enable proposed APIs [cannot be published to the
Marketplace](https://code.visualstudio.com/api/advanced-topics/using-proposed-api).

- **Not Copilot's exact widget.** Copilot renders deleted lines as phantom lines
  in the document and floats Keep/Undo beside them. That specific UI lives in VS
  Code core and is not exposed to extensions at all — there is no proposed API to
  opt into. The Quick Diff widget and the comment threads used here render the
  original lines inline and host the same two actions, but with VS Code's chrome
  rather than Copilot's.
- **Two sets of gutter bars in a Git repo.** VS Code draws change bars for every
  visible Quick Diff provider. In a Git repository, Git compares against `HEAD`
  and this extension compares against the pre-Claude baseline — usually the same
  lines, so you may see both. Hide either one from the Source Control view's
  *Toggle Quick Diff Visibility* action, or set
  `claudeKeepUndo.inlineReview` to `comments` or `off`.
  The Quick Diff widget shows one provider at a time; the **Keep** / **Undo**
  buttons appear when the widget is showing *Claude Changes*.
- **A second Source Control provider.** Registering the Quick Diff provider means
  a *Claude Changes* entry appears in the Source Control view alongside Git. It
  is not a real SCM — there is no commit box — and it doubles as the pending-file
  list. `claudeKeepUndo.sourceControlList` empties that list; the registration
  itself has to stay for as long as the gutter bars are wanted, because they come
  from it.
- **Left-click in the Explorer is not overridable.** Use the changes view, the
  context menu, or `autoOpenDiff`.
- **Diff layout is a global setting.** VS Code has no per-editor diff layout, so
  while a Claude diff is **visible** the extension temporarily sets
  `diffEditor.renderSideBySide=false` and `diffEditor.codeLens=true`, restoring
  your values once none is on screen. Visible, not focused: clicking into another
  editor group next to the diff leaves the layout alone. Set
  `claudeKeepUndo.diffMode` to `"sideBySide"` to opt out of the inline layout.
- **CodeLens cannot be styled.** Extensions cannot color or bold a CodeLens, and
  codicons render dimmed inside one, so the only way to make Keep/Undo stand out
  is an emoji — `claudeKeepUndo.codeLensStyle: "emoji"`, off by default because
  it ignores your color theme. VS Code also computes lenses asynchronously; they
  are pre-warmed before the diff opens, but a small reflow can remain on very
  large files.
- **CodeLens is per document, not per editor.** With `codeLens: "diffOnly"`, a
  file open in both a diff tab and an ordinary tab shows the rows in both: the
  provider is given the document and never learns which editor is asking.
- **Transcript-only coverage is partial by design.** Without the hooks, an edit
  whose original state cannot be reconstructed *exactly* is listed as
  *not reviewable* rather than shown against a guessed baseline — including every
  `replace_all` edit, which is not reversible from the transcript at all. Install
  the hooks for full coverage.
- **User edits are detected per file, not per line.** The extension knows a file
  has been edited by you, not which lines are yours, so the Undo warning fires
  for the whole file.
- **Only UTF-8 text.** Files whose bytes do not survive a UTF-8 round trip are
  refused rather than round-tripped through a lossy decode — checked on the bytes
  themselves, so a windows-1252 source with a handful of accented characters is
  caught too. Such files are listed with an explanation, and their recorded
  original is kept rather than deleted.
- **Line endings are reviewed, not diffed.** The diff itself ignores line
  terminators, which is what keeps a Keep or an Undo from rewriting every line in a
  CRLF file. A rewrite that changes *only* the terminators — the ordinary result of
  Claude's `Write` tool touching a CRLF file — therefore has no per-line rendering:
  it is listed as **line endings changed**, and Undo restores the original bytes.
  Restoring such a file bypasses the editor, so that particular Undo is not on the
  editor's undo stack (the recovery snapshot still covers it).
- **Very different versions collapse to one hunk.** Past a large edit distance
  the changed region is reported as a single replacement; the UI says so.
- **`diffEditor.renderSideBySide` and `diffEditor.codeLens` are temporarily
  overridden** while a Claude diff tab is open, and restored when you leave it —
  and nothing is written at all when your own value already matches. The original
  values are persisted first, per window, and put back by the next window to start
  if a crash interrupts the restore. If a write into your `settings.json` fails
  (VS Code refuses to write one that has syntax errors), you are told which key is
  affected. Still: if you disable or uninstall the extension while a diff is open,
  check those two settings.
- **Single-root only.** The first workspace folder is handled — the usual
  Claude Code layout.
- **`claudeKeepUndo.trackOutsideWorkspace` only reaches the transcript channel.**
  The hook command records the workspace root when it is installed, so files
  outside the open folder are filtered out there regardless of the setting. Turning
  it on and reinstalling the hooks is the workaround.
- **Case-insensitive paths are matched by spelling in memory.** On Windows and
  macOS the on-disk state folds case, but the in-memory review state does not, so a
  path VS Code and Claude Code spell with different casing can be tracked without
  the editor surfaces recognising it. Not reproducible on a normal macOS setup;
  Windows drive-letter casing is the case to watch.

---

## Development

```bash
git clone https://github.com/FedeFluork/claude-keep-undo.git
cd claude-keep-undo
npm install
npm run compile     # or: npm run watch
```

Press **F5** (launch configuration *Run Extension*) to open an Extension
Development Host, then open a project where Claude Code is running.

### Tests

```bash
npm run lint               # eslint + prettier --check
npm run format             # prettier --write
npm run test:unit          # pure logic, Node's built-in test runner
npm run test:integration   # drives the extension in a real VS Code
npm test                   # both
```

The unit tests cover the diff engine, the transcript baseline reconstruction, how
transcript tool calls and their results are read, the hook settings merge and
registration classification, the file IO helpers, the manifest contributions, the
transcript reader driven end to end against real `.jsonl` files, and the
multi-window behaviour of the temporary `diffEditor.*` overrides. The last two run
against a stubbed `vscode`, because every failure in the layout group was *between*
windows and the reader only resolves inside the extension host. No test framework
dependency, just `node:test`. The integration tests
download VS Code on first run and need `@vscode/test-electron` ≥ 3.1.0 (VS Code
1.110+ renamed the macOS executable). CI runs everything on Linux, macOS and
Windows.

### Packaging

```bash
npm run package     # npx @vscode/vsce package
```

`vscode:prepublish` recompiles TypeScript automatically. The result is a
`claude-keep-undo-<version>.vsix` in the project root.

### Project layout

| Path | Role |
|---|---|
| `src/extension.ts` | Activation, provider/command registration, wiring |
| `src/changeStore.ts` | State (baselines, pending hunks), recompute, keep/undo actions |
| `src/diff.ts` | Dependency-free LCS line-diff engine, plus `LineChange` ↔ hunk mapping |
| `src/util.ts` | Path hashing, project-dir encoding, safe file IO |
| `src/detection/hookInstaller.ts` | Install/repair hooks, with settings safety |
| `src/detection/hookSettings.ts` | Pure hook-config merge and state classification |
| `src/detection/keepUndoWatcher.ts` | Watches `<state>/baselines/**` (hook channel) |
| `src/detection/transcriptOffsets.ts` | Decides where to start reading each transcript |
| `src/detection/transcriptWatcher.ts` | Tails the transcripts, reconstructs baselines |
| `src/detection/transcriptEvents.ts` | Pure: which tool calls are believed, and when |
| `src/detection/reconstruct.ts` | Pure, verified baseline reconstruction |
| `src/ui/quickDiff.ts` | Source Control + Quick Diff provider (gutter bars, inline widget, pending list) |
| `src/ui/commentReview.ts` | Optional inline comment threads with Keep/Undo |
| `src/ui/codeActions.ts` | Keep/Undo as Quick Fixes on the hunk under the cursor |
| `src/ui/diffView.ts` | `claude-baseline:` content provider + diff opening |
| `src/ui/fileDecorations.ts` | Explorer badge |
| `src/ui/codeLens.ts` | Per-hunk and per-file Keep/Undo CodeLens |
| `src/ui/format.ts` | Shared hunk formatting helpers |
| `src/test/unit/**` | Pure-logic tests (`node:test`) |
| `src/test/integration/**` | End-to-end tests in a real VS Code |
| `src/ui/diffLayout.ts` | Forces inline diff + `diffEditor.codeLens`, avoids layout flash |
| `src/ui/changesView.ts` | File → hunk tree view with inline actions |
| `hooks/keepundo-hook.mjs` | Hook script executed by Claude Code |
| `scripts/check-encoding.mjs` | Fails the build on a NUL byte in a source file |

---

## Privacy

The extension does not make network requests, collect telemetry, or send
anything anywhere. It reads your workspace files and your local Claude Code
session transcripts, and writes baselines and recovery snapshots into VS
Code's per-workspace storage — outside your repository, never inside it.
All of it stays on your machine.
