# Changelog

All notable changes to **Keep / Undo for Claude Code** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0]

First public release.

Earlier builds existed only as locally installed `.vsix` files and were never
published, so these notes cover the whole distance from there. 194 unit tests and
34 integration tests run in CI on Linux, macOS and Windows.

### Added — change detection and the review surfaces

- Explorer badge (`✳`) and themeable color for files Claude modified.
- Diff view against a recorded pre-Claude baseline (`claude-baseline:` scheme).
- Per-hunk `Keep` / `Undo` CodeLens plus per-file `Keep all` / `Undo all`.
- *Claude: Changes to Review* tree view with per-file and per-hunk inline
  actions and global Keep All / Undo All.
- Change detection via Claude Code `PreToolUse`/`PostToolUse` hooks.
- Zero-config change detection via the session transcript, reconstructing
  baselines by reverse-applying recorded edits.
- Inline (unified) diff layout with automatic restore of the user's
  `diffEditor.renderSideBySide` and `diffEditor.codeLens` settings.

### Added — the inline review UI

- **In-file review on stable API.** A Source Control provider now owns a
  `QuickDiffProvider`, which gives coloured change bars in the editor gutter and
  VS Code's Quick Diff widget rendering the original lines inline. **Keep** and
  **Undo** are contributed to that widget's toolbar through the
  `scm/change/title` menu, gated on `originalResourceScheme == claude-baseline`
  so they never appear on Git's changes.
- **Inline comment threads** as an alternative in-file presentation: the removed
  and added lines rendered between the editor lines with Keep/Undo in the thread
  toolbar. Controlled by the new `claudeKeepUndo.inlineReview` setting
  (`quickDiff` | `comments` | `both` | `off`).
- **Keep/Undo as Quick Fixes** on the hunk under the cursor, for a
  `Ctrl+.` / `Cmd+.` keyboard flow.
- **Keep/Undo on the line-number context menu.**
- **Review All Claude Changes (Multi-File Diff)** — opens every pending file in a
  single Multi Diff Editor tab via the built-in `vscode.changes` command.
- A *Claude Changes* Source Control entry listing the pending files with inline
  Keep/Undo actions and a count badge.
- **Recovery snapshots** and the *Claude Keep/Undo: Reveal Recovery Snapshots*
  command. Every destructive action copies the file aside first; copies are kept
  for 14 days.

### Added — review flow

- **Go to next / previous change** (`Ctrl+Alt+N` / `Ctrl+Alt+P`, `Cmd` on
  macOS), wrapping at both ends. There were commands to act on a change and none
  to *find* one, so reviewing a long file meant hunting for gutter bars.
- **Keep / Undo from the keyboard** (`Ctrl+Alt+K` / `Ctrl+Alt+U`). All four
  bindings are scoped to files Claude has actually changed, so they give the
  keys back everywhere else.
- **Restore the last Undo.** Every Undo now ends in a notification with a
  **Restore** button that puts the file back exactly as Claude left it —
  content *and* baseline, so it returns to the queue rather than being silently
  accepted. Also available as a command. The recovery snapshot always made this
  possible by hand; now it is a button at the moment you need it.
- **Keep and Undo confirm themselves** in the status bar (`Kept 3 changes in
  auth.ts`). From the Quick Fix menu or the line-number menu there was
  previously no sign that anything had happened when the change was off-screen.
- **A status bar entry** counting the files awaiting review, clickable straight
  into the multi-file diff — the only ambient signal that survives having the
  Explorer closed.
- **A count badge on the changes view header**, so a collapsed *Claude: Changes
  to Review* still reports its queue. The Source Control entry always had one.

### Added — configuration

- **A setup panel**: *Claude Keep/Undo: Settings and Setup*, also on the gear in
  the changes view title bar. Shows what is currently detected (hooks,
  transcript, pending queue), offers **Minimal** / **Recommended** /
  **Everything** presets, and explains what each surface costs before you turn
  it on. It writes ordinary VS Code settings, per user or per workspace.
- **A four-step walkthrough** on the Getting Started page, so the hook install
  has a home other than a startup notification.
- **The Settings editor entries are grouped and ordered** — *Review surfaces*,
  *Pending queue*, *Safety and feedback*, *Detection* — with a label and an
  explanation for every enum value. They used to be seven flat properties in
  historical order, with the two that change what you see below the detection
  toggles.
- New settings beyond those above: `claudeKeepUndo.viewBadge`,
  `claudeKeepUndo.statusBar`, `claudeKeepUndo.sourceControlList`,
  `claudeKeepUndo.confirmUndo`, `claudeKeepUndo.feedback.undoNotification`,
  `claudeKeepUndo.feedback.statusBarMessage`.

### Added — tooling and metadata

- **Files Claude changed but that cannot be reviewed are listed** in the changes
  view with the reason, instead of silently disappearing.
- **Diffs too large to split are labelled as such** in the view and the CodeLens,
  rather than looking like a mysterious single whole-file change.
- A one-time explanation, in Git repositories, of why two sets of change bars
  appear in the gutter — with a one-click switch to inline comments.
- Marketplace icon, `capabilities.untrustedWorkspaces` and
  `capabilities.virtualWorkspaces` declarations, and `engines.node`.
- ESLint + Prettier, and a GitHub Actions workflow running lint, unit tests,
  integration tests, packaging, and a tag-triggered publish.
- A manifest test suite guarding the menu contributions, which depend on VS Code
  context keys that nothing else checks.

### Changed — where state lives

- **Review state moved out of your repository** into VS Code's per-workspace
  storage. `baselines/` and `snapshots/` hold verbatim copies of your source
  files, and inside the repo they were one `git add -A` away from being
  committed. Existing state under `<workspace>/.claude/keepundo/` is moved
  automatically on first activation.
- **Hooks are registered in `.claude/settings.local.json`**, Claude Code's
  machine-local settings file, instead of the shared `.claude/settings.json` —
  the command contains absolute paths that do not belong in a committed file. An
  install made by a pre-1.0 build is migrated out of the shared file, preserving
  everything else in it.
- The hook now receives `--state`, so state always lands where the extension is
  watching even when `claude` was launched from a subdirectory.

### Changed — the default set of review surfaces

The extension used to show seven overlapping review surfaces at once, and only
one of them could be turned off. That was not a design, it was the union of
every option that had been implemented. The surfaces are now a coherent choice,
and **every one of them is a setting**.

- **CodeLens moved into the diff editor** (`claudeKeepUndo.codeLens`, default
  `diffOnly`). Two rows per change, plus three at the top of the file, meant a
  six-hunk file lost fifteen lines of height in the editor you were trying to
  read — on top of the gutter bars and the Quick Fixes already there. Set it to
  `always` for the previous behaviour, or `off`.
- **CodeLens reads `Keep` / `Undo` rather than `✅ Keep` / `❌ Undo`**
  (`claudeKeepUndo.codeLensStyle`, default `text`). Extensions cannot style a
  lens, so the emoji were the only way to stand out — at the cost of ignoring
  the color theme and reading far louder than any other lens in the editor.
  `emoji` restores them.
- **Quick Fix no longer offers whole-file actions from anywhere in the file**
  (`claudeKeepUndo.quickFixes`, default `hunkAndFile`). *Undo all Claude changes
  in this file* used to sit next to *Add missing import* on an ESLint error four
  hundred lines from any change, in a menu people operate by muscle memory. All
  four actions now require the cursor to be inside a change.
- **The Explorer badge no longer propagates to the workspace root**
  (`claudeKeepUndo.explorerBadge`, default `file`). A mark that is on whenever
  anything anywhere is pending carries no information, and it collided with
  Git's own folder decorations. `fileAndFolders` restores it.
- **The Explorer right-click entry appears only when something is pending.**
  `resourceScheme == file` is every file in the project, so *Open Diff of
  Claude's Changes* was a context-menu entry whose usual outcome was an apology.
  It can also be removed entirely (`claudeKeepUndo.explorerContextMenu`).

### Changed — wording and layout

- **Changes view rows lead with the code**, not the coordinates: `const retries
  = 5` in the label and `L14 · +3 −1` beside it, the way the Search and Problems
  views are laid out.
- **Diff tabs are titled `auth.ts (Claude)`** instead of `src/api/auth.ts:
  baseline ↔ Claude's changes`. Tabs truncate from the right, so the old title
  rendered as `src/api…` with three tabs open — the half that does not identify
  the file. The parent directory is added back only when two pending files share
  a basename.
- **One name for the degraded state.** *too different to split*, *whole region*,
  *one change (too different to split)* and a fourth phrasing in the tooltip are
  now all **whole file rewritten**, with a single explanation behind it.
- **The doubled-gutter explanation waits for something to look at.** It used to
  fire at activation in every Git repository, before any bar or widget existed —
  an unprompted advertisement that spent its one chance on nothing. It now
  appears the first time a tracked file is actually visible with gutter bars on,
  and is marked as seen *after* it has been answered rather than before it is
  shown, so a restart or a burst of other toasts no longer swallows it.
- **The empty changes view no longer offers to install hooks that are already
  installed** — the steady state of a healthy install used to show a button that
  rewrote `.claude/settings.local.json` for no reason.
- **Clicking a "not reviewable" row opens the file** instead of writing to
  `.claude/settings.local.json`. Installing the hooks is a button on the row.

### Changed — naming, packaging and engine

- Minimum VS Code version raised to `1.90.0` (the Multi Diff Editor requires
  1.86+), and `@types/vscode` pinned to exactly that version so the code cannot
  compile against APIs newer than the declared engine.
- Fully localized the extension to English: settings, commands, view names,
  notifications, tooltips and log output.
- Renamed the display name to *Keep / Undo for Claude Code* and added an
  explicit "unofficial, not affiliated with Anthropic" disclaimer. The extension
  identifier settled at `FedeFluork.claude-keep-undo`. Nothing had been
  published under the old name, so no installed extension is affected.
- Rewrote the README for public distribution and added `repository`, `bugs` and
  `homepage` metadata to `package.json`.
- Expanded `.gitignore` and `.vscodeignore` for a public repository and a clean
  package.

### Fixed — the five paths that could destroy your work

Every one of these is a path where the extension could destroy the user's work
while reporting success.

**1. Baselines reconstructed from the session transcript could be wrong, and
prove themselves right.** The reconstruction is verified by replaying the
recorded edits forward and requiring the result to match what is on disk — but
that proof is self-consistent, and three ordinary situations passed it while
producing a baseline that never existed.

- **A `replace_all` edit is no longer reversed at all.** `foo -> bar` over a file
  whose second line was the user's own `bar` produced the baseline `foo\nfoo\n`,
  which replays forward to exactly the current content and so verified — and Undo
  then rewrote a line Claude never touched. Whether the replacement text already
  existed is not recorded anywhere, and Claude Code's own tool result reports no
  count, so there is nothing to decide it with. The file now falls back to the
  hook baseline, or is listed as not reviewable.
- **A tool call is only ingested once its result says it happened.** Edits Claude
  Code refused ("String to replace not found in file"), calls the user denied at
  the permission prompt, and records that physically appear twice in the
  transcript were all treated as real edits. Calls are now buffered by
  `tool_use` id and committed only against a non-error `tool_result`; a repeated
  record is inert, and a call whose result never arrives makes the file not
  reviewable instead of being reconstructed from the calls that did land.
- **A store event with no uri no longer discards a reconstruction in flight.**
  "Has no baseline" and "is resolved" were the same test, so *Keep All*, *Undo
  All* or an unreviewable file appearing during a Claude burst threw away the
  edits already recorded for every other file — and the next edit registered a
  partial baseline, holding Claude's own output, as the user's original.
- **A pre-`Write` snapshot must prove it predates the write.** The strategy rests
  on reading the file before the tool runs, but the transcript is only polled —
  every 30 s once it backs off, and with no watcher at all in a project whose
  session directory does not exist yet. A late read gets Claude's output, and a
  follow-up edit in the same burst then made it differ from the current content,
  which was the only test. The file's mtime is now recorded and required to
  predate the tool call. The poll also backs off on transcript silence rather
  than edit silence, and `~/.claude/projects` is watched for the session
  directory being created.

**2. An Undo could lose its own parachute.**

- **A failed save no longer destroys the baseline.** The edit was applied to the
  open document *before* saving, so a save that failed — a read-only file, a save
  conflict — left the buffer dirty holding the restored content. The recompute
  that followed prefers a dirty buffer over disk, found no difference, and deleted
  the baseline: the only copy of the pre-Claude content, gone, while Claude's
  changes were still on disk and the UI said the Undo had failed. The buffer is now
  rolled back, the failure paths can no longer resolve anything, and an unsaved
  buffer alone is never accepted as proof that a change was reviewed.
- **A recovery snapshot that cannot be written stops the Undo.** All four call
  sites discarded the result, so a full disk or an unwritable state directory
  destroyed the file anyway — right after a dialog promising a copy had been
  saved. Having nothing to copy (undoing a file Claude deleted) still proceeds.
- **An unreadable file after an Undo keeps its baseline.** It was read as a
  successful restore, and the baseline deleted, thirteen lines from the code that
  refuses to act on exactly that condition.
- **"Undo could not be written to disk" now means the write failed.** It was also
  shown when the write *succeeded* and a save participant reformatted the result —
  format-on-save, insert-final-newline — which is an everyday outcome. The
  pre-Undo content was already replaced, the message said otherwise, and the
  Restore button that was the only way back was suppressed. That case is now a
  warning, the file stays under review, and the restore point is armed.

**3. *Restore the Last Undo* is now disarmed when it stops being safe.** It was
the one destructive write in the extension that took no recovery snapshot, had no
confirmation and no expiry, so it sat in the view title for the rest of the
session and re-applied whole-file content captured arbitrarily long ago.

- A recovery snapshot is taken before it writes, like every other write here.
- It refuses any path whose content or baseline has moved since the Undo, and says
  which files it left alone and where the bytes still are.
- The record is dropped as soon as a file it covers changes again, and expires
  after five minutes.
- The Restore button on a notification restores *that* Undo. It read "the most
  recent one" at click time, so a click on "Undid 1 change in fileA.ts" restored
  fileB.ts. A superseded notification now explains itself.

**4. The temporary `diffEditor.*` overrides can no longer be left in your
settings.** The crash-recovery record was a single key in `globalState`, which
every VS Code window on the machine shares.

- Records are keyed per window session and carry a heartbeat, so a second window
  can tell a dead session's leftovers from a live sibling's override.
- A window never adopts another live window's override as "the value the user
  chose" — which is how `diffEditor.renderSideBySide: false` ended up permanently
  in a user's settings, with Settings Sync propagating it to every machine, and
  how a committed `.vscode/settings.json` got the extension's values written into
  the repository.
- A newly activating window no longer replays a live sibling's record, so an open
  review does not flip out of inline diff mid-review; and the record is cleared
  with a compare-and-swap, so a race cannot end with the override applied and
  nothing left to undo it.
- Releasing an override writes *first* and drops the state after. The other order
  meant a rejected write (VS Code refuses to write a `settings.json` with a syntax
  error) left the override on disk with the state saying otherwise — and the next
  override then recorded its own leftover as the user's value. A failed write is
  now surfaced once and retried on the next release.
- The two settings are released independently, so a failure on one no longer skips
  the other. And nothing is written at all when the effective value is already
  what is wanted.

**5. A file that is not UTF-8 can no longer be corrupted by its own baseline.**
Everything here is stored as UTF-8 text, and the only guard was a density
heuristic on already-decoded content — which needs more than one bad byte per two
hundred characters and only looks at the first 8 KiB.

- **The hook refuses to stage a file whose bytes do not survive a UTF-8 round
  trip**, and records the refusal in its event log rather than returning silently.
  A 2 KB PNG replaced by a text placeholder used to be staged as a mojibake string
  and promoted as the baseline, so Undo destroyed the original outright.
- **Reads are validated at the byte level**, not by decoding first and guessing. A
  windows-1252 source with three accented characters in five thousand passed the
  heuristic, so Undo silently wrote `Jos�` over `José` — one character lost per
  accent, with no warning anywhere.
- **Each baseline records the byte length captured with it**, and a baseline whose
  stored length disagrees is refused whatever the density of bad bytes, from any
  producer.
- **Recovery snapshots are byte-exact copies.** They were written as decoded text,
  so the copy taken to protect a file was itself the corrupted version.
- A file that cannot be reviewed safely is listed with an explanation and **keeps
  its baseline**: that is still the only copy of the pre-Claude content, and
  deleting it was never a fix for the file's encoding.

### Fixed — Undo All

Cross-cutting to all five: what *Undo All* confirms, what it acts on and what it
reports were three different things.

- **It acts only on the set it confirmed.** The work list was re-read from live
  state at call time, i.e. *after* the modal — and the watchers keep registering
  baselines while a modal is up. Every file that appeared in that window was
  reverted without being named in the confirmation, without a snapshot the Restore
  button could use, and — if Claude had created it — deleted with no deletion
  warning at all.
- **A partial failure no longer costs everyone else their restore point.** One file
  reformatted by Prettier on save was reported as a failure, and the command
  returned before arming the Restore for the ninety-nine files that really were
  overwritten. Successes are now registered first, reformatted files are reported
  as what they are, and deletions are mentioned in the partial-success message too.
- **The counts add up.** The success message counted the pre-dialog total rather
  than what was done, and the error message used it as the denominator. Files
  skipped because they were no longer pending are now reported separately.
- **The strongest confirmation states its scope.** With one hand-edited file among
  forty pending, the dialog described that one file, asserted "Undo restores the
  whole file", and offered *Undo Anyway* — the safer-looking case was the one that
  said less. It now names the count and the risk together.

### Fixed — silent failures

Everything else that could lose the user's work, silently stop the extension
working, or write to their settings behind their back.

**Detection could die, or lie, without saying anything.**

- **A transcript line larger than 1 MiB no longer kills the reader for the rest
  of the session.** The reader consumed at most a megabyte at a time and required
  a newline inside that window; finding none it returned *without advancing the
  offset*, so every later tick re-read the same megabyte — synchronously, on the
  extension-host thread — and every edit Claude made afterwards was invisible,
  with no error, no log line and no warning. Claude reading a large lockfile or
  writing a large file is enough to produce such a line; the largest one in the
  transcripts on this machine was already 756 KB. An over-long line is now skipped
  and logged, and a backlog is drained rather than trickled one chunk per poll.
- **Offsets are counted in bytes, not in decoded characters.** The two agree only
  when a read begins on a character boundary, and the reader attaches at a raw
  file size sampled at an arbitrary instant — which can land inside a multi-byte
  character, whose orphan bytes decode to U+FFFD at three bytes each. The recorded
  offset then overshot the line boundary, the next line started part-way in, failed
  to parse, and was dropped in silence. A missing edit is exactly the case where
  reconstruction verifies and is still wrong: with one of two edits lost, the
  recorded "original" of a file contained Claude's own output in place of the
  user's line, and Undo would have written it back. Any project with non-ASCII text
  in its transcript was exposed.

**Keep and Undo could act on a revision that no longer existed.**

- **Every per-hunk action now checks that the file is still the one the hunks were
  computed from.** The content checks inside the apply functions cannot establish
  that: for a pure deletion the current-side check has an empty expectation and so
  matches at *any* position, and the baseline-side check compares against a string
  the store only ever replaces wholesale. So a file rewritten under the store — a
  `git checkout`, a `prettier --write` from a terminal, a keystroke inside the
  200 ms debounce — had the restored lines spliced in where they no longer belonged,
  and the action reported success. The store already recorded the digest it needed;
  it now compares it.
- **A Quick Diff widget action is cross-checked against the store's own hunks.**
  The widget's coordinates come from VS Code's editor model as of whenever it last
  diffed, and the hunk derived from them has its lines sliced out of the very texts
  it is then verified against — so the verification compared a slice with itself and
  could never fail. A stale widget deleted the user's lines, duplicated Claude's,
  and reported "applied"; the Keep counterpart wrote a baseline for a file that had
  never existed. The derived region must now sit inside a difference the store
  actually computed.

**Line endings.**

- **A rewrite that only changes line endings is now reviewable instead of
  invisible.** The diff normalizes CRLF before comparing, which is right for
  display — there is no sensible per-line rendering of a terminator change — but it
  made such a rewrite indistinguishable from no change at all, and "no change" is
  what told the store the file was fully reviewed and its baseline could be deleted.
  Claude's `Write` tool emits LF, so every CRLF file was one `Write` away from
  losing its original terminators permanently. The file now stays under review as
  *line endings changed*, and Undo restores them byte for byte.
- **A restored baseline is no longer rewritten by the editor on its way to disk.**
  A text document holds one line ending for the whole buffer and rewrites every
  terminator to it, so writing CRLF content into a buffer VS Code had loaded as LF
  produced LF on disk — and the store then reported the file as restored. Content
  whose terminators the open document cannot represent now bypasses the editor.
- **Splicing at the end of a file no longer converts that line's terminator.** The
  terminator for a line that used to be last was taken from the target text, and
  the detector cannot do better than LF for a text containing no terminator at all
  — which is exactly the shape in question. Undoing a truncation in a CRLF file
  with no final newline silently converted its first line, and because the diff is
  EOL-blind the store then saw no difference and deleted the baseline. The
  terminator is now taken from the block being inserted, which carries the file's
  own.

**Baselines could be deleted after the UI said "Kept".**

- **A failed descriptor write fails the action.** The result of writing a
  baseline's sidecar was discarded, and a baseline with no readable sidecar is
  indistinguishable from an orphan — so the next sweep deleted it, taking every
  unreviewed change in that file with it, after the UI had already reported
  success. The descriptor is now written first and checked, and a failure restores
  the previous one rather than leaving one that describes bytes that were never
  written.
- **An unreadable descriptor is no longer read as a missing one.** The sweep
  deleted the content file whenever the sidecar could not be *read*, conflating a
  transient `EACCES`, an `EMFILE` while sweeping hundreds of baselines, or an
  indexer holding the file open with genuine absence. Only absence justifies the
  delete now, and a just-promoted baseline is given a grace window, since promotion
  writes the content and the descriptor as two operations.

**Confirmations that did not fire.**

- **A per-hunk Undo on a file you have edited now asks first.** The `risky` setting
  — the default — is documented as "asks when you have edited the file yourself
  since Claude did", but the change scope returned before that list was ever
  consulted. The store re-diffs after every keystroke, so a line typed next to
  Claude's edit is merged into the same hunk and the splice takes it too. The
  dialog now fires, with wording scoped to the hunk rather than the whole file.
- **An edit made *before* Claude's is remembered.** The flag was only ever set for
  files already under review, so the dangerous ordering was the one thrown away:
  the user types without saving, Claude then edits the file, and the baseline is
  read from disk — so those unsaved lines are absent from it and are attributed to
  Claude. Undo discarded them with no dialog. Edits to untracked files are now
  recorded (bounded, and cleared when the file is reviewed).
- **The first keystroke counts.** VS Code announces a content change while the
  document is still clean and sets the dirty flag on a separate event with no
  content changes, so a condition requiring both at once never matched: the opening
  edit of every editing session went unrecorded.

**Quick Diff on an empty side.**

- **Clicking one change in a file Claude filled from empty no longer acts on all of
  it.** The empty-baseline special case returned the whole file regardless of the
  coordinates reported, and with the default confirmation there is no dialog for a
  single change — so one click could accept, or wipe, 120 lines.
- **A file Claude emptied can be undone from the widget.** The mirror case had no
  handling at all: every coordinate shape VS Code reports for it either failed the
  range check, so the action was refused forever, or produced a hunk that dropped
  the restored file's final newline.

**Stale content in the review UI.**

- **A hunk's identity now covers all of it.** It was digested from its first and
  last hundred lines plus its length, so two hunks differing anywhere in between
  were byte-identical — and every whole-file rewrite is longer than that. Comment
  threads key their "has anything changed?" check on exactly this, so a later edit
  inside a long hunk left the thread rendering the previous revision while Keep
  folded the *current* content into the baseline: the user accepted lines they had
  never been shown.

**Settings and layout written behind the user's back.**

- **A visible Claude diff keeps its layout.** Whether to hold the two borrowed
  `diffEditor` settings was decided from the focused tab alone, so clicking into any
  other editor group released them while the diff was still fully visible beside
  it: it reflowed from unified to split and every per-hunk `Keep · Undo` row
  disappeared. Clicking back flipped it again, and each flip was a real write to
  settings.json — in the workspace case, to a file that is usually committed.
- **Automatically opening the diff no longer follows your own typing.** It was
  driven by the store's general change event, which also fires from the debounced
  recompute and from noticing a user edit — so after a window reload with pending
  changes, the first character typed in a tracked file opened a diff tab and took
  the focus mid-sentence. Detection now has its own event.
- **The detection toggles take effect immediately.** Both detectors were built
  inside one-shot checks at activation and never reconciled, so turning one off left
  it running — still polling, still adding entries to the changes view — while the
  extension's own settings panel, which reads the values live, drew a chip saying it
  was off. Turning one on did nothing until a reload, with no hint that one was
  needed.

**Hook registration.**

- **A malformed `.claude/settings.json` cannot break activation.** Valid JSON in an
  unexpected shape — a single object where an array belongs, which Claude Code
  itself tolerates — made the merge throw, and the throw aborted activation after
  the watchers were registered but before the menus, the status bar and the
  extension's API. That took down the transcript channel too, which has nothing to
  do with hooks. Every read of the file is now total, and the activation path is
  guarded as well.
- **A half-wired registration is repaired instead of reported healthy.** The check
  compared the flat set of command strings and discarded the event key and the
  matcher, so five broken shapes all reported `ok` and were never repaired: both
  commands under one event, the two swapped, the matcher rewritten, either one
  parked under an unrelated event, or a stray extra copy. The worst is not merely
  inert — with both under `PreToolUse` the post hook runs before the edit and
  promotes a baseline identical to the file on disk, so every change resolves to
  nothing while verbatim copies of the user's source pile up in the staging
  directory.
- **The same project opened in two VS Code builds works.** A registration recorded
  by another build was classified as somebody else's script, because the check
  required the *same* extensions directory. Stable, Insiders, Cursor and a source
  checkout each have their own, so the second window showed a security-flavoured
  warning on every activation, with no way to dismiss it, and never repointed the
  hooks at its own state directory — reviewing nothing at all, permanently. Any
  editor's extensions directory now counts; a script inside the workspace still
  does not, whatever it is named. The warning is dismissable and opens the file the
  registration is actually in, rather than one that usually does not exist.
- **Stripping our install out of a committed settings file no longer deletes what
  it cannot parse.** A `hooks` block in an unfamiliar shape came back missing,
  which is a silent rewrite of a file the user had committed.

### Fixed — data safety

- **Undo on a file Claude created now deletes it** instead of leaving an empty
  file behind. Both detectors recorded "this file did not exist" as an empty
  baseline, which is indistinguishable from "the file existed and was empty" — so
  Undo wrote an empty file that survived, opened, and still showed in
  `git status` as an addition you believed you had reverted. The distinction now
  travels with the baseline, the deletion goes through the editor's undo stack,
  a recovery snapshot is taken first, and every deletion is named and confirmed.
- **Keep/Undo on the line-number menu can no longer hit the wrong hunk.** On the
  baseline side of a diff the line numbers are baseline coordinates but the
  lookup resolves current-content ones, so a right-click on the left pane could
  revert a different hunk — and the fingerprint guard could not catch it, being
  derived from the index it had just resolved. That side is now refused outright
  and the menu no longer appears there.
- **A staged pre-edit copy left by a denied tool call no longer poisons later
  baselines.** Staging entries now carry a timestamp and expire after 60 s, and a
  completed review deletes them. Previously a `PreToolUse` whose `PostToolUse`
  never ran blocked all future captures for that file and was eventually promoted
  as the "original" for an edit made days later — so Undo restored week-old
  content.
- **A whole-file `Write` is never reconstructed as an empty baseline.** It used to
  produce `baseline = ""`, which made *Undo* truncate the file. The watcher now
  snapshots the file when the `Write` is announced and only trusts that snapshot
  once the file has actually changed; otherwise the file is reported as not
  reviewable.
- **`.claude/settings.json` is never overwritten when it cannot be parsed.** A
  trailing comma used to be indistinguishable from "no file", and the installer
  replaced the user's entire Claude Code configuration. It now refuses, explains
  why, and keeps a `.bak` copy before its first write.
- **Keep/Undo cannot be applied to the wrong hunk.** Every hunk carries a
  content fingerprint that travels with the command, and the splice itself
  verifies that the lines at the target offsets are the ones the hunk claims to
  replace. A stale action is refused with a message instead of corrupting the
  file.
- **Undo is now reversible.** Destructive actions snapshot the file first (see
  *Reveal Recovery Snapshots*), always write through the editor's undo stack, and
  ask for confirmation naming any file you have also edited yourself.
- **Deletions and ambiguous edits are no longer guessed.** Transcript
  reconstruction refuses a deletion (which has no anchor), refuses a replacement
  that occurs more than once, and *proves* every result by replaying the edits
  forward. Coverage without hooks is narrower as a result — deliberately.

### Fixed — detection

- **A Claude session started after VS Code is no longer skipped.** In a project
  that had never run Claude Code the session directory does not exist, so every
  early sweep came back empty — and an empty sweep did not count as "this is what
  existed before us". The transcript of the session you were about to start was
  then classified as history and attached at its end, silently losing every edit
  made in the first 30 seconds. Exactly the advertised zero-config first run.
- **Files outside the open folder are no longer tracked** by default. Claude
  edits its own settings, scratch files and sibling repositories routinely;
  those were given baselines in this workspace's storage and rows in a view that
  could not show them. New setting `claudeKeepUndo.trackOutsideWorkspace`. The
  hook now receives `--root` and filters there too, so their content is never
  copied into this workspace's storage in the first place.
- **A write snapshot can no longer outlive its tool call.** A stale
  "this file did not exist" entry, left behind by Keep All, made the next write
  to that path look like a creation — which, with the change above, meant Undo
  deleted a file the user had just chosen to keep. Snapshots now expire, bulk
  actions clear them, and a deletion additionally requires a baseline that is
  genuinely empty rather than only the recorded flag.
- **The hook no longer treats an unreadable file as a missing one.** A transient
  lock (Windows file sharing, antivirus) was recorded as "Claude created this".
- Hooks left behind in the shared `.claude/settings.json` by a pre-1.0 install are
  now cleaned up even when the local install is healthy — Claude Code was running
  a dead command on every edit. A `keepundo-hook.mjs` that is not ours is still
  reported rather than removed.
- The hook command is now **verified by running it**, once, exactly as Claude
  Code will. `node` missing from the hook shell's PATH (usual under nvm, asdf and
  Volta) used to fail silently forever while the hooks reported as installed.

### Fixed — reliability

- Hooks are repaired automatically after an extension update instead of silently
  failing while still reporting as installed. A `keepundo-hook.mjs` that is not
  ours is now reported rather than trusted.
- The hook receives the state directory explicitly (`--state`), so state is no
  longer written under a subdirectory nobody watches when `claude` is launched
  from one.
- `index.json` is gone: each baseline carries its own sidecar, removing the
  lost-update race between the hook process and the extension.
- Resuming an older Claude session no longer replays its entire history into the
  review queue, and all transcripts are followed instead of only the most
  recently touched one.
- The diff engine was rewritten (prefix/suffix peeling + interned lines + Myers
  O((N+M)·D)). A 40,000-line file with one changed line now yields one precise
  hunk in milliseconds; it previously exceeded the size guard and degraded to a
  single whole-file hunk.
- File writes create their parent directory, clean up after themselves and report
  failure instead of throwing into VS Code's event dispatch.
- Transcript reads are chunked at 1 MB instead of allocating the whole file.

### Fixed — correctness and UI

- **Line endings are preserved.** Keep/Undo used to re-join the whole file with
  one detected terminator, so a three-line Undo in a CRLF or mixed-EOL file
  produced a diff touching every line. Only the lines in the hunk are replaced
  now.
- **Files that are not UTF-8 text are refused** instead of being round-tripped
  through a lossy decode and corrupted on Undo.
- **A deleted or unreadable file is no longer treated as an empty one.** A
  missing file is labelled as deleted (Keep forgets it, Undo restores it); an
  unreadable one is left alone rather than reported as "Claude deleted
  everything".
- **Undo no longer silently accepts what save participants did to it.** If
  format-on-save or organise-imports rewrites the restored content, the file
  stays under review instead of resolving.
- **Path identity is case-correct** on macOS and Windows, so the same file
  reached through different casing no longer produces two baselines.
- `atomicWrite` now flushes before renaming, so a crash cannot leave a
  zero-length baseline that reads as "the file was empty before".
- A resolved file's diff tab is closed instead of quietly becoming an empty diff.
- The Explorer badge is sliced by code point, so a two-emoji badge is no longer
  cut in half.
- Duplicate hook matcher blocks are merged instead of appended.
- The event log is size-capped instead of growing forever, and is no longer
  watched — every hook call used to trigger a full store refresh.
- **Keep and Undo now work on a file Claude created from the Quick Diff widget.**
  VS Code reports an empty original as one line where the engine counted none, so
  every action on such a file came back "that change moved".
- Inline comment threads no longer show a stale diff when a hunk changes without
  changing shape: the redraw key now digests content, not just positions.
- *Review All Claude Changes* gets its per-hunk CodeLens: the Multi Diff Editor
  tab was not recognised, so the multi-file review had no affordance at all.
- The temporary `diffEditor.*` overrides are written at the scope that is
  actually in effect. A workspace-level value silently shadowed them, which
  turned off the per-hunk CodeLens inside the diff — the primary review
  affordance — with no error anywhere. A value you change while an override is
  held is now adopted instead of discarded.
- *Reveal Recovery Snapshots* reports an empty state instead of revealing a
  directory that does not exist.
- Keep/Undo on a file with nothing pending says so instead of doing nothing.
- A bulk refresh now updates open baseline documents, and the baseline content
  provider no longer leaks its listener.
- Two stray NUL bytes in `src/diff.ts` made the diff engine a binary file to
  `git`, `grep` — and to this extension, which would have refused to review its
  own engine as "not UTF-8 text".

### Fixed — review actions and UI wiring

- Keep/Undo invoked from the Quick Diff widget resolve the change from its own
  line coordinates instead of a possibly stale hunk index, and report a clear
  message when the change no longer applies.
- The changes view keeps its expansion state across refreshes (stable
  `TreeItem.id`).
- The editor-title Keep/Undo buttons now appear for the file that is already open
  at activation, and stay visible when focus is on the baseline side of the diff.
- `autoOpenDiff` re-arms after Keep All / Undo All instead of never re-opening a
  file it had already shown.
- Pending recompute timers are cleared on deactivation instead of firing against
  a disposed store.
- A resolved file no longer leaves stale "whole file added" quick diff
  decorations behind.
- Hunk tooltips in the changes view render as a colourised `diff` block.

### Fixed — packaging

- **Package contents are excluded by pattern and verified in CI.**
  `.vscodeignore` listed the project's working documents one file name at a time,
  so a file added later was packaged for the Marketplace — 375 KB of it. The
  exclusions are patterns now, `.DS_Store` is excluded in every directory rather
  than only the root, and CI fails the build if a stray `.DS_Store` or an
  unexpected markdown file makes it into the package.

### Performance

- A recompute whose content has not changed returns immediately instead of
  splitting the file into one string per line and running a Myers search. This
  is the debounced-keystroke path.
- Fingerprinting a whole-file hunk samples head, tail and length rather than
  hashing both versions of the file, per keystroke.
- A hook write recomputes the file it touched instead of every tracked file: a
  run touching a hundred files no longer costs a hundred diffs per event.
- The transcript poll backs off from 1.5 s to 30 s when nothing is happening,
  instead of scanning the session directory forever.
- Baseline reconstruction waits for the whole transcript to go quiet, not just
  one file, so a burst can no longer produce a permanent partial baseline.
- `recompute` reads the baseline from memory instead of from disk on every
  keystroke.
- Comment threads are updated in place instead of being destroyed and recreated,
  so they no longer collapse while Claude is working.
- Undo writes files above 512 KB directly instead of opening a document for them.

### Tests

- **194 unit tests** over the pure logic on Node's built-in `node:test` runner
  (no new dependency), plus **34 integration tests** driving the extension in a
  real VS Code. `npm test` runs both.
- `npm run lint` now fails on a NUL byte in any source file.
- One unit test encoded the wrong assumption rather than catching it: it asserted
  that reversing `replace_all` over `y y y` yields `x x x`. It now asserts the
  refusal, and the case it got wrong is a test.
- Another encoded a *cost* guarantee that was hiding a correctness bug: it required
  hunk fingerprinting not to scale with hunk size, which is what the head/tail
  sampling bought and what made a change in the middle of a long hunk invisible. It
  now asserts that a middle change is noticed, alongside a loose ceiling on the cost
  of doing it properly.
- The transcript reader is now driven end to end against real `.jsonl` files in a
  temp directory, with `vscode` stubbed: an over-long line, a partial final line, an
  attach inside a multi-byte character, and a multi-megabyte backlog. It is where
  the worst failures lived, and it had no coverage at all.
- Transcript reading — which tool calls are believed, and when a pre-`Write`
  snapshot can be trusted — moved into `detection/transcriptEvents.ts`, free of any
  `vscode` import, so the decisions that turn an Undo into data loss are covered by
  plain unit tests like `reconstruct.ts` already was.
- The multi-window `diffEditor.*` behaviour is covered by driving the compiled
  controller against a stubbed `vscode` with one shared settings store, one shared
  memento and one shared config event bus. Every failure in that group was
  *between* windows, and none of it is reachable from a single-window test.
