import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { KeepUndoApi } from "../../extension";
import {
  atomicWrite,
  baselinesDir,
  fileExists,
  pathKey,
  pendingDir,
  sidecarPath,
  snapshotsDir,
} from "../../util";

const EXT_ID = "FedeFluork.claude-keep-undo";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Keep / Undo for Claude Code", () => {
  let root: string;
  let stateDir: string;
  let api: KeepUndoApi;
  const created: string[] = [];

  /** Write a baseline the way the hook script does, sidecar included. */
  function seedBaseline(
    file: string,
    baseline: string,
    wasCreated = false
  ): string {
    const content = path.join(baselinesDir(stateDir), pathKey(file));
    atomicWrite(content, baseline);
    atomicWrite(
      sidecarPath(content),
      JSON.stringify({ path: file, ts: Date.now(), created: wasCreated })
    );
    return content;
  }

  async function ourCodeLenses(file: string): Promise<vscode.CodeLens[]> {
    const uri = vscode.Uri.file(file);
    // The provider command needs a resolvable text model, so make sure the
    // document is loaded before asking for its lenses.
    await vscode.workspace.openTextDocument(uri);
    const lenses =
      (await vscode.commands.executeCommand<vscode.CodeLens[]>(
        "vscode.executeCodeLensProvider",
        uri
      )) ?? [];
    return lenses.filter((l) =>
      l.command?.command.startsWith("claudeKeepUndo.")
    );
  }

  /** Set one of our settings for the duration of the test host. */
  async function configure(key: string, value: unknown): Promise<void> {
    await vscode.workspace
      .getConfiguration("claudeKeepUndo")
      .update(key, value, vscode.ConfigurationTarget.Global);
  }

  before(async function () {
    this.timeout(60_000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "a workspace folder must be open for the tests");
    root = folder.uri.fsPath;

    const ext = vscode.extensions.getExtension<KeepUndoApi>(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} must be present`);
    api = await ext.activate();
    assert.ok(api?.stateDir, "the extension must report its state directory");
    assert.ok(api.store, "the extension must expose its store to the tests");
    stateDir = api.stateDir;

    // Most tests below use the CodeLenses as the visible proxy for "this file is
    // under review". That is a diff-editor surface by default, so ask for the
    // ordinary editor explicitly; the default is covered by its own test.
    await configure("codeLens", "always");
  });

  after(async () => {
    await configure("codeLens", undefined);
  });

  afterEach(async () => {
    await vscode.commands.executeCommand("claudeKeepUndo.keepAll");
    for (const file of created.splice(0)) {
      fs.rmSync(file, { force: true });
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  function makeFile(name: string, content: string): string {
    const file = path.join(root, name);
    fs.writeFileSync(file, content);
    created.push(file);
    return file;
  }

  /** How many recovery snapshots exist for a file right now. */
  function countSnapshots(file: string): number {
    const dir = snapshotsDir(stateDir);
    if (!fileExists(dir)) {
      return 0;
    }
    return fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(pathKey(file)) && !n.endsWith(".json"))
      .length;
  }

  it("keeps its state outside the workspace", () => {
    // Baselines and snapshots are verbatim copies of the user's source; one
    // `git add -A` away from committing whatever secrets those files held.
    const relative = path.relative(root, stateDir);
    assert.ok(
      relative.startsWith(".."),
      `state directory ${stateDir} must not be inside ${root}`
    );
  });

  it("registers every contributed command", async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    const contributed: string[] = [
      "claudeKeepUndo.openDiff",
      "claudeKeepUndo.openAllChanges",
      "claudeKeepUndo.keepHunk",
      "claudeKeepUndo.undoHunk",
      "claudeKeepUndo.keepChange",
      "claudeKeepUndo.undoChange",
      "claudeKeepUndo.keepAtLine",
      "claudeKeepUndo.undoAtLine",
      "claudeKeepUndo.keepFile",
      "claudeKeepUndo.undoFile",
      "claudeKeepUndo.keepAll",
      "claudeKeepUndo.undoAll",
      "claudeKeepUndo.keepAtCursor",
      "claudeKeepUndo.undoAtCursor",
      "claudeKeepUndo.nextChange",
      "claudeKeepUndo.previousChange",
      "claudeKeepUndo.restoreLastUndo",
      "claudeKeepUndo.installHooks",
      "claudeKeepUndo.openSettings",
      "claudeKeepUndo.openWalkthrough",
      "claudeKeepUndo.refresh",
      "claudeKeepUndo.revealSnapshots",
    ];
    for (const command of contributed) {
      assert.ok(registered.has(command), `${command} is not registered`);
    }
  });

  it("tracks a file seeded through the sidecar state format", async () => {
    const file = makeFile("it-tracked.txt", "alpha\nCHANGED\ngamma\n");
    seedBaseline(file, "alpha\nbeta\ngamma\n");

    await vscode.commands.executeCommand("claudeKeepUndo.refresh");
    await vscode.window.showTextDocument(vscode.Uri.file(file));

    const lenses = await ourCodeLenses(file);
    assert.ok(lenses.length > 0, "expected Keep/Undo CodeLenses");

    const perHunk = lenses.filter(
      (l) => l.command?.command === "claudeKeepUndo.keepHunk"
    );
    assert.equal(perHunk.length, 1, "expected exactly one changed hunk");

    // The fingerprint must travel with the command, otherwise a lens rendered
    // against an older revision could be applied to the wrong hunk.
    const args = perHunk[0].command?.arguments ?? [];
    assert.equal(args[0], file);
    assert.equal(typeof args[1], "number");
    assert.equal(typeof args[2], "string");
    assert.ok((args[2] as string).length > 0);
  });

  it("clears its on-disk state when a file is kept", async () => {
    const file = makeFile("it-keep.txt", "one\nTWO\n");
    const baseline = seedBaseline(file, "one\ntwo\n");
    // A staging file left by a Pre hook whose Post never ran must go too:
    // otherwise it is promoted as the baseline for a much later edit.
    const pending = path.join(pendingDir(stateDir), pathKey(file));
    atomicWrite(pending, "one\ntwo\n");
    atomicWrite(sidecarPath(pending), JSON.stringify({ path: file, ts: 1 }));

    await vscode.commands.executeCommand("claudeKeepUndo.refresh");
    assert.ok((await ourCodeLenses(file)).length > 0);

    await vscode.commands.executeCommand("claudeKeepUndo.keepFile", file);

    assert.equal(fileExists(baseline), false, "baseline should be removed");
    assert.equal(
      fileExists(sidecarPath(baseline)),
      false,
      "baseline sidecar should be removed"
    );
    assert.equal(fileExists(pending), false, "stale pending should be removed");
    assert.equal(
      fileExists(sidecarPath(pending)),
      false,
      "stale pending sidecar should be removed"
    );
    assert.equal(fs.readFileSync(file, "utf8"), "one\nTWO\n");
    assert.deepEqual(await ourCodeLenses(file), []);
  });

  it("restores the baseline when a file is undone", async () => {
    const original = "keep\nthis\ncontent\n";
    const file = makeFile("it-undo.txt", "keep\nCLAUDE WROTE THIS\ncontent\n");
    const baseline = seedBaseline(file, original);

    await vscode.commands.executeCommand("claudeKeepUndo.refresh");
    assert.ok((await ourCodeLenses(file)).length > 0);

    await vscode.commands.executeCommand("claudeKeepUndo.undoFile", file);
    await wait(300);

    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.equal(fileExists(baseline), false);
    assert.deepEqual(await ourCodeLenses(file), []);
  });

  it("leaves a recovery snapshot behind before undoing", async () => {
    const file = makeFile("it-snapshot.txt", "before\nAFTER\n");
    seedBaseline(file, "before\nafter\n");
    await vscode.commands.executeCommand("claudeKeepUndo.refresh");

    await vscode.commands.executeCommand("claudeKeepUndo.undoFile", file);
    await wait(300);

    const snapshots = fs
      .readdirSync(path.join(stateDir, "snapshots"))
      .filter((n) => n.startsWith(pathKey(file)) && !n.endsWith(".json"));
    assert.ok(snapshots.length > 0, "an Undo must be recoverable");
    const saved = fs.readFileSync(
      path.join(stateDir, "snapshots", snapshots[0]),
      "utf8"
    );
    assert.equal(saved, "before\nAFTER\n");
  });

  it("undoes a single hunk and leaves the others alone", async () => {
    const file = makeFile("it-hunk.txt", "a\nB\nc\nd\nE\nf\n");
    seedBaseline(file, "a\nb\nc\nd\ne\nf\n");

    await vscode.commands.executeCommand("claudeKeepUndo.refresh");
    const lenses = (await ourCodeLenses(file)).filter(
      (l) => l.command?.command === "claudeKeepUndo.undoHunk"
    );
    assert.equal(lenses.length, 2);

    const args = lenses[0].command?.arguments ?? [];
    await vscode.commands.executeCommand(
      "claudeKeepUndo.undoHunk",
      args[0],
      args[1],
      args[2]
    );
    await wait(300);

    const text = fs.readFileSync(file, "utf8");
    assert.ok(text.includes("\nb\n"), "the undone hunk should be reverted");
    assert.ok(text.includes("\nE\n"), "the other hunk should be untouched");
  });

  it("does not rewrite the line endings of a CRLF file", async () => {
    const original = "a\r\nb\r\nc\r\n";
    const file = makeFile("it-crlf.txt", "a\r\nB\r\nc\r\n");
    seedBaseline(file, original);

    await vscode.commands.executeCommand("claudeKeepUndo.refresh");
    await vscode.commands.executeCommand("claudeKeepUndo.undoFile", file);
    await wait(300);

    const text = fs.readFileSync(file, "utf8");
    assert.equal(text, original);
    assert.ok(
      !/(?<!\r)\n/.test(text),
      "no terminator should have been changed"
    );
  });

  it("refuses a Keep whose fingerprint no longer matches", async () => {
    const file = makeFile("it-stale.txt", "x\nY\nz\n");
    seedBaseline(file, "x\ny\nz\n");
    await vscode.commands.executeCommand("claudeKeepUndo.refresh");

    const before = fs.readFileSync(file, "utf8");
    await vscode.commands.executeCommand(
      "claudeKeepUndo.keepHunk",
      file,
      0,
      "0000000000000000"
    );
    await wait(200);

    // The action is refused, so nothing is written and the file still differs.
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.ok((await ourCodeLenses(file)).length > 0);
  });

  it("refuses to track a file that is not UTF-8 text, and keeps its baseline", async () => {
    const file = path.join(root, "it-binary.bin");
    fs.writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0xfe]));
    created.push(file);
    const baseline = seedBaseline(file, "harmless text\n");

    await vscode.commands.executeCommand("claudeKeepUndo.refresh");
    await wait(200);

    // Round-tripping the bytes through UTF-8 would corrupt them on Undo, so it is
    // not reviewable — but the baseline stays: it is the only copy of the
    // pre-Claude content, and deleting it is not a fix for the file's encoding.
    assert.equal(api.store.isTracked(file), false);
    assert.equal(fileExists(baseline), true, "the recovery data must survive");
    assert.ok(
      api.store.getUnreviewable().some((u) => u.path === file),
      "the file must be listed with an explanation rather than vanish"
    );
  });

  it("refuses a sparsely non-UTF-8 file the density heuristic lets through", async () => {
    // The silent half of the corruption. A windows-1252 source with three accented
    // characters in five thousand passes `looksBinary`, so it used to be tracked —
    // and Undo wrote `Jos�` over `José`, one character lost per accent, with no
    // warning anywhere.
    const file = path.join(root, "it-latin1.java");
    fs.writeFileSync(
      file,
      Buffer.from(
        "// author: Jos\xe9 Mu\xf1oz, r\xe9vision\n" +
          "const x = 1;\n".repeat(400),
        "latin1"
      )
    );
    created.push(file);
    seedBaseline(file, "// author: someone\n");

    await vscode.commands.executeCommand("claudeKeepUndo.refresh");
    await wait(200);

    assert.equal(api.store.isTracked(file), false);
    assert.ok(api.store.getUnreviewable().some((u) => u.path === file));
  });

  it("refuses a baseline whose byte count disagrees with what was captured", async () => {
    // A baseline is only useful if it is a byte-exact copy of what the producer
    // read. The sidecar records the source's byte length at capture time, so a copy
    // that was decoded lossily — three bytes of U+FFFD where one byte was — gives
    // itself away whatever the density, which the heuristic cannot do.
    const file = makeFile("it-badbytes.txt", "current\n");
    const content = path.join(baselinesDir(stateDir), pathKey(file));
    atomicWrite(content, "original\n");
    atomicWrite(
      sidecarPath(content),
      // 9 bytes on disk, but the producer says it read 40.
      JSON.stringify({ path: file, ts: Date.now(), created: false, bytes: 40 })
    );

    await vscode.commands.executeCommand("claudeKeepUndo.refresh");
    await wait(200);

    assert.equal(api.store.isTracked(file), false);
    assert.ok(api.store.getUnreviewable().some((u) => u.path === file));
    assert.equal(
      fileExists(content),
      true,
      "the bytes are still the only copy"
    );
  });

  it("deletes a file Claude created instead of emptying it", async () => {
    // An empty baseline used to be indistinguishable from "the file existed and
    // was empty", so Undo wrote an empty file: it survived, it opened, and it
    // still showed in `git status` as an addition the user believed they undid.
    const file = makeFile("it-created.txt", "brand new\ncontent\n");
    seedBaseline(file, "", /*created*/ true);

    await vscode.commands.executeCommand("claudeKeepUndo.refresh");
    assert.equal(api.store.isCreated(file), true, "the flag must survive disk");
    assert.ok((await ourCodeLenses(file)).length > 0);

    // Driven through the store: the command wraps this in a modal confirmation
    // that a test host cannot answer.
    const result = await api.store.undoFile(file);

    assert.equal(result, "applied");
    assert.equal(fileExists(file), false, "the created file must be gone");
    assert.equal(api.store.isTracked(file), false);
  });

  it("saves a snapshot before deleting a file Claude created", async () => {
    const file = makeFile("it-created-snap.txt", "recoverable\n");
    seedBaseline(file, "", /*created*/ true);
    await vscode.commands.executeCommand("claudeKeepUndo.refresh");

    await api.store.undoFile(file);

    const snapshots = fs
      .readdirSync(path.join(stateDir, "snapshots"))
      .filter((n) => n.startsWith(pathKey(file)) && !n.endsWith(".json"));
    assert.ok(snapshots.length > 0, "a deletion must still be recoverable");
    assert.equal(
      fs.readFileSync(path.join(stateDir, "snapshots", snapshots[0]), "utf8"),
      "recoverable\n"
    );
  });

  it("restores an ordinary empty baseline as an empty file, not a deletion", async () => {
    // The other half of the same distinction: this file really did exist and
    // really was empty, so Undo must put an empty file back.
    const file = makeFile("it-was-empty.txt", "claude added this\n");
    seedBaseline(file, "", /*created*/ false);
    await vscode.commands.executeCommand("claudeKeepUndo.refresh");

    const result = await api.store.undoFile(file);

    assert.equal(result, "applied");
    assert.equal(fileExists(file), true, "the file must still exist");
    assert.equal(fs.readFileSync(file, "utf8"), "");
  });

  it("refuses to delete unless the baseline is genuinely empty", () => {
    // Defence in depth for the created flag. It is set far away — by a hook that
    // may misread a locked file, or by a write snapshot — and the cost of it
    // being wrong is removing a file that was never Claude's to remove.
    const file = makeFile("it-wrongflag.txt", "content\n");
    seedBaseline(file, "it existed, with this in it\n", /*created*/ true);
    void vscode.commands.executeCommand("claudeKeepUndo.refresh");

    assert.equal(
      api.store.wouldDelete(file),
      false,
      "a non-empty baseline must never resolve to a deletion"
    );
  });

  it("does not mistake a directory named `..cache` for an escape", () => {
    const inside = path.join(root, "..cache", "a.ts");
    const outside = path.join(path.dirname(root), "elsewhere", "a.ts");
    assert.equal(api.store.isInScope(inside), true);
    assert.equal(api.store.isInScope(outside), false);
  });

  it("ignores files outside the workspace folder", () => {
    const outside = path.join(
      os.tmpdir(),
      `keepundo-outside-${Date.now()}.txt`
    );
    fs.writeFileSync(outside, "not ours\n");
    try {
      assert.equal(api.store.isInScope(outside), false);
      api.store.registerBaseline(outside, "before\n");
      assert.equal(api.store.isTracked(outside), false);
      assert.equal(
        fileExists(path.join(baselinesDir(stateDir), pathKey(outside))),
        false,
        "no baseline may be written for a file outside the workspace"
      );
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("reports rather than reveals an empty snapshots directory", async () => {
    // Revealing a directory that does not exist does nothing at all on macOS,
    // which reads as a broken safety net.
    await vscode.commands.executeCommand("claudeKeepUndo.revealSnapshots");
    assert.equal(
      fileExists(path.join(stateDir, "snapshots")),
      true,
      "the command must at least create the directory it points at"
    );
  });

  it("keeps the CodeLens out of the ordinary editor by default", async () => {
    // Two rows per change, each displacing a line of code, is a lot to pay in
    // the editor you are trying to read. The default puts them in the diff,
    // which is the one place nothing else is competing for the space.
    const file = makeFile("it-lens-scope.txt", "a\nB\nc\n");
    seedBaseline(file, "a\nb\nc\n");
    await vscode.commands.executeCommand("claudeKeepUndo.refresh");

    await configure("codeLens", "diffOnly");
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(file));
      assert.deepEqual(
        await ourCodeLenses(file),
        [],
        "no lenses belong in the plain editor"
      );

      await vscode.commands.executeCommand("claudeKeepUndo.openDiff", file);
      await wait(300);
      assert.ok(
        (await ourCodeLenses(file)).length > 0,
        "the diff must still offer per-change Keep/Undo"
      );
    } finally {
      await configure("codeLens", "always");
    }
  });

  it("titles the diff tab with the file name, not the path", async () => {
    // Tabs truncate from the right, so a title that leads with the directory
    // loses exactly the half that identifies the file.
    const file = makeFile("it-title.txt", "new\n");
    seedBaseline(file, "old\n");
    await vscode.commands.executeCommand("claudeKeepUndo.refresh");

    await vscode.commands.executeCommand("claudeKeepUndo.openDiff", file);
    await wait(300);

    const label = vscode.window.tabGroups.activeTabGroup.activeTab?.label ?? "";
    assert.ok(label.startsWith("it-title.txt"), `unexpected title: ${label}`);
    assert.ok(label.includes("(Claude)"), `unexpected title: ${label}`);
  });

  it("moves the cursor to the next change and wraps around", async () => {
    const file = makeFile("it-next.txt", "a\nB\nc\nd\nE\nf\n");
    seedBaseline(file, "a\nb\nc\nd\ne\nf\n");
    await vscode.commands.executeCommand("claudeKeepUndo.refresh");

    const editor = await vscode.window.showTextDocument(vscode.Uri.file(file));
    editor.selection = new vscode.Selection(0, 0, 0, 0);

    await vscode.commands.executeCommand("claudeKeepUndo.nextChange");
    assert.equal(editor.selection.active.line, 1, "first change is on line 2");

    await vscode.commands.executeCommand("claudeKeepUndo.nextChange");
    assert.equal(editor.selection.active.line, 4, "second change is on line 5");

    // Past the last one, come back to the first rather than stopping silently.
    await vscode.commands.executeCommand("claudeKeepUndo.nextChange");
    assert.equal(editor.selection.active.line, 1);

    await vscode.commands.executeCommand("claudeKeepUndo.previousChange");
    assert.equal(editor.selection.active.line, 4);
  });

  it("puts an undone file back under review, content and baseline together", async () => {
    // The recovery snapshot on disk always made an Undo reversible by hand.
    // This is the same guarantee reachable from the notification's Restore
    // button — and restoring the baseline is what makes the file come back
    // *awaiting review* rather than as the user's own work.
    const original = "keep\nthis\n";
    const claudes = "keep\nCLAUDE WROTE THIS\n";
    const file = makeFile("it-restore.txt", claudes);
    seedBaseline(file, original);
    await vscode.commands.executeCommand("claudeKeepUndo.refresh");

    const snapshot = api.store.captureUndoSnapshot(file);
    assert.ok(snapshot, "a tracked file must be capturable");
    assert.equal(snapshot.content, claudes);
    assert.equal(snapshot.baseline, original);

    assert.equal(await api.store.undoFile(file), "applied");
    await wait(300);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.equal(api.store.isTracked(file), false);

    const { failed, stale } = await api.store.restoreUndoSnapshots([snapshot]);
    await wait(300);

    assert.deepEqual(failed, []);
    assert.deepEqual(stale, []);
    assert.equal(fs.readFileSync(file, "utf8"), claudes);
    assert.equal(
      api.store.isTracked(file),
      true,
      "the restored file must be awaiting review again"
    );
    assert.equal(api.store.getBaseline(file), original);
  });

  it("copies the file aside before a Restore overwrites it", async () => {
    // This was the one destructive write in the extension that took no recovery
    // snapshot, so the content it replaced was the only content that could not be
    // got back — while the content it wrote was already in the snapshots folder.
    const file = makeFile("it-restore-snap.txt", "claude\nwrote this\n");
    seedBaseline(file, "user\nwrote this\n");
    await vscode.commands.executeCommand("claudeKeepUndo.refresh");

    const snapshot = api.store.captureUndoSnapshot(file);
    assert.ok(snapshot);
    await api.store.undoFile(file);
    await wait(200);

    const before = countSnapshots(file);
    await api.store.restoreUndoSnapshots([snapshot]);
    await wait(200);

    assert.ok(
      countSnapshots(file) > before,
      "the Restore must be as reversible as every other write here"
    );
  });

  it("refuses a Restore whose file has moved on since the Undo", async () => {
    // The record holds whole-file content captured before an Undo. Re-applying it
    // twenty minutes later used to overwrite everything done in between — no
    // dialog, no snapshot, no staleness check.
    const file = makeFile("it-restore-stale.txt", "claude\nwrote this\n");
    seedBaseline(file, "user\nwrote this\n");
    await vscode.commands.executeCommand("claudeKeepUndo.refresh");

    const captured = api.store.captureUndoSnapshot(file);
    assert.ok(captured);
    await api.store.undoFile(file);
    await wait(200);
    // Stamped after the undo, exactly as the command layer does.
    const [snapshot] = api.store.stampPostUndo([captured]);

    // The user then rewrites the file by hand.
    const theirWork = "user\nrewrote all of this by hand\n";
    fs.writeFileSync(file, theirWork);
    await wait(100);

    const { failed, stale } = await api.store.restoreUndoSnapshots([snapshot]);

    assert.deepEqual(failed, []);
    assert.deepEqual(
      stale,
      [file],
      "a moved file must be reported, not written"
    );
    assert.equal(
      fs.readFileSync(file, "utf8"),
      theirWork,
      "the newer work must survive"
    );
  });

  it("undoes only the paths it was given, not whatever is tracked now", async () => {
    // `undoAll` used to re-read the live tracked map at call time, i.e. *after* the
    // confirmation modal — and the watchers keep registering baselines while a
    // modal is up. Everything that appeared in that window was reverted without
    // being named in the confirmation and without a snapshot the Restore could use.
    const confirmed = makeFile("it-batch-a.txt", "CLAUDE\n");
    seedBaseline(confirmed, "user a\n");
    await vscode.commands.executeCommand("claudeKeepUndo.refresh");

    // Registered after the set was frozen, as a watcher would during the dialog.
    const late = makeFile("it-batch-b.txt", "CLAUDE\n");
    seedBaseline(late, "user b\n");
    await vscode.commands.executeCommand("claudeKeepUndo.refresh");

    const result = await api.store.undoPaths([confirmed]);
    await wait(300);

    assert.equal(result.applied, 1);
    assert.deepEqual(result.failed, []);
    assert.equal(fs.readFileSync(confirmed, "utf8"), "user a\n");
    assert.equal(
      fs.readFileSync(late, "utf8"),
      "CLAUDE\n",
      "a file that was never confirmed must be left alone"
    );
    assert.equal(api.store.isTracked(late), true);
  });

  it("reports the files it skipped, so the counts add up", async () => {
    const gone = path.join(root, "it-batch-gone.txt");
    const result = await api.store.undoPaths([gone]);
    assert.deepEqual(result.skipped, [gone]);
    assert.equal(result.applied, 0);
    assert.deepEqual(result.failed, []);
  });

  it("opens the settings panel", async () => {
    // The panel's HTML is generated from the shared settings schema, so this
    // exercises the whole table — a malformed control would throw here rather
    // than render as an empty page in front of a user.
    await vscode.commands.executeCommand("claudeKeepUndo.openSettings");
    await wait(400);

    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab, "no tab opened");
    assert.match(tab.label, /Settings/);

    // Asking twice reveals the one panel instead of stacking a second.
    await vscode.commands.executeCommand("claudeKeepUndo.openSettings");
    await wait(200);
    const panels = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.label === tab.label);
    assert.equal(panels.length, 1);
  });

  it("refuses a hunk action on a file that moved since it was diffed", async () => {
    // `sliceMatches` returns true for any in-range position when the expected
    // slice is empty, and every deletion hunk has `currentLines: []` — so the
    // current-side check verified nothing at all, and the baseline-side check runs
    // against a string the store only replaces wholesale. A file rewritten under
    // the store (a `git checkout`, a `prettier --write` from a terminal, a
    // keystroke inside the 200 ms debounce) therefore had the restored lines
    // spliced in at a position that no longer meant that, and the action reported
    // success. Here: baseline `a b b b c`, Claude removed one `b`, then the file
    // loses its first line — the Undo used to append `b` after `c`.
    const file = makeFile("it-moved.txt", "a\nb\nb\nc\n");
    seedBaseline(file, "a\nb\nb\nb\nc\n");
    await vscode.commands.executeCommand("claudeKeepUndo.refresh");
    assert.equal(api.store.getTracked().length > 0, true);

    const fingerprint = api.store.getTracked()[0].hunks[0].fingerprint;
    // Rewritten behind the store's back, exactly as an external tool would.
    fs.writeFileSync(file, "b\nb\nc\n");

    const result = await api.store.undoHunk(file, 0, fingerprint);
    assert.equal(result, "stale");
    assert.equal(
      fs.readFileSync(file, "utf8"),
      "b\nb\nc\n",
      "nothing may be written when the hunk no longer describes the file"
    );
  });

  it("keeps an EOL-only rewrite reviewable instead of deleting the baseline", async () => {
    // `computeHunks` normalizes CRLF, so a rewrite that only converts terminators
    // diffed to nothing — and "nothing" is what told the store the file was fully
    // reviewed, so `resolve()` deleted the baseline and the original terminators
    // became unrecoverable. Claude's Write tool emits LF, so any CRLF file is one
    // Write away from this.
    const file = makeFile("it-eol.txt", "alpha\nbeta\n");
    const content = seedBaseline(file, "alpha\r\nbeta\r\n");
    await vscode.commands.executeCommand("claudeKeepUndo.refresh");

    assert.equal(api.store.isTracked(file), true, "it must stay under review");
    assert.ok(fileExists(content), "and keep its baseline");

    await vscode.commands.executeCommand("claudeKeepUndo.undoFile", file);
    await wait(300);
    assert.equal(
      fs.readFileSync(file, "utf8"),
      "alpha\r\nbeta\r\n",
      "Undo must put the original terminators back"
    );
    assert.equal(api.store.isTracked(file), false, "and then resolve");
  });

  it("never deletes a baseline because its sidecar could not be read", async () => {
    // `readSidecar` collapses "could not be read" into "is not there", and the
    // sweep deleted the content file on that single undefined. A transient EACCES
    // or EMFILE while sweeping, or an indexer holding the .json open, therefore
    // destroyed the only copy of the pre-Claude content.
    const file = makeFile("it-sidecar.txt", "new\n");
    const content = seedBaseline(file, "old\n");
    // Present but unparseable, which is what a torn or locked read looks like.
    fs.writeFileSync(sidecarPath(content), "{ not json");

    await vscode.commands.executeCommand("claudeKeepUndo.refresh");
    await wait(200);

    assert.ok(
      fileExists(content),
      "the baseline must survive an unreadable descriptor"
    );
  });

  it("drops a baseline that genuinely has no descriptor", async () => {
    // The other half: without a sidecar nothing can ever match the content again,
    // so it would sit in storage forever. Only *absence* justifies the delete.
    const orphan = path.join(baselinesDir(stateDir), "it-orphan-key");
    atomicWrite(orphan, "orphaned\n");
    // Older than the grace window that covers a two-step promotion.
    const old = Date.now() - 60_000;
    fs.utimesSync(orphan, old / 1000, old / 1000);

    await vscode.commands.executeCommand("claudeKeepUndo.refresh");
    await wait(200);

    assert.equal(fileExists(orphan), false);
  });

  it("remembers a user edit made before Claude's, so Undo is confirmed", async () => {
    // `noteUserEdit` returned early for files it was not already tracking, so the
    // store only ever learned about edits made *after* ingestion. The dangerous
    // ordering is the other one: the user types without saving, Claude then edits
    // the file, and the baseline is read from disk — so those unsaved lines are
    // absent from it and get attributed to Claude. Undo discarded them with no
    // dialog, because the flag that gates the dialog was never set.
    const file = makeFile("it-pre-edit.txt", "one\n");
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit((b) => b.insert(new vscode.Position(1, 0), "mine\n"));
    await wait(300);
    assert.equal(doc.isDirty, true, "the buffer must be dirty and unsaved");
    assert.equal(
      api.store.isUserTouched(file),
      true,
      "a single first keystroke is enough: VS Code announces the content change " +
        "while the document is still clean, and the dirty flag on its own event"
    );

    // Claude's edit lands now, and the baseline comes from disk.
    seedBaseline(file, "one\n");
    await vscode.commands.executeCommand("claudeKeepUndo.refresh");
    await wait(200);

    assert.equal(
      api.store.isUserTouched(file),
      true,
      "the earlier edit must still be on record"
    );
    await vscode.commands.executeCommand(
      "workbench.action.revertAndCloseActiveEditor"
    );
  });

  it("serves the recorded baseline on the claude-baseline scheme", async () => {
    const file = makeFile("it-baseline.txt", "new\n");
    seedBaseline(file, "old\n");
    await vscode.commands.executeCommand("claudeKeepUndo.refresh");

    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(file).with({ scheme: "claude-baseline" })
    );
    assert.equal(doc.getText(), "old\n");
  });
});
