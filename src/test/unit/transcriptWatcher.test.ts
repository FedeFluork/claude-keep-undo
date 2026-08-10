/**
 * End-to-end tests for the transcript reader, driven against real files on disk.
 *
 * This is the component that had no coverage and every Critical finding: it is the
 * only detection channel that works without hooks installed, and its failures are
 * silent by construction — a dropped line produces a baseline that passes the
 * forward verification and is still wrong, and a stalled offset produces nothing at
 * all, with no error anywhere.
 *
 * `vscode` only resolves inside the extension host, so it is stubbed the way
 * `diffLayout.test.ts` does it. Everything else is the real thing: real `.jsonl`
 * files in a temp directory, the real parser, the real reconstruction.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import Module from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

type Listener = (uri: unknown) => void;

const vscodeStub = {
  Disposable: class {
    dispose(): void {}
  },
  Uri: { file: (p: string) => ({ fsPath: p, scheme: "file" }) },
  window: { showWarningMessage: () => Promise.resolve(undefined) },
  commands: { executeCommand: () => Promise.resolve(undefined) },
};

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
interface LoadableModule {
  _load: Loader;
}
const loader = Module as unknown as LoadableModule;
const realLoad: Loader = loader._load.bind(Module);
loader._load = (request: string, parent: unknown, isMain: boolean) =>
  request === "vscode" ? vscodeStub : realLoad(request, parent, isMain);

/** Just enough ChangeStore to talk to, plus a record of what it was told. */
class FakeStore {
  readonly registered: { path: string; baseline: string }[] = [];
  readonly unreviewable = new Map<string, string>();
  private readonly baselines = new Set<string>();
  private listeners: Listener[] = [];

  onDidChange(listener: Listener): { dispose(): void } {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  }
  isInScope(): boolean {
    return true;
  }
  hasBaseline(p: string): boolean {
    return this.baselines.has(p);
  }
  registerBaseline(p: string, baseline: string): void {
    this.registered.push({ path: p, baseline });
    this.baselines.add(p);
  }
  noteUnreviewable(p: string, reason: string): void {
    this.unreviewable.set(p, reason);
  }
  clearUnreviewable(p: string): void {
    this.unreviewable.delete(p);
  }
  recompute(): void {}
}

interface Watcher {
  tick(): void;
  dispose(): void;
}
type WatcherCtor = new (
  cwd: string,
  store: unknown,
  log: (msg: string) => void
) => Watcher;

const { TranscriptWatcher } = loader._load(
  "../../detection/transcriptWatcher",
  module,
  false
) as { TranscriptWatcher: WatcherCtor };
const { sessionDirFor } = loader._load("../../util", module, false) as {
  sessionDirFor: (cwd: string) => string;
};

// `sessionDirFor` resolves against `os.homedir()`, which reads HOME on POSIX and
// USERPROFILE on Windows. Stubbing only HOME leaves the runner's real home in
// effect on Windows, where every test in this file then fails in `beforeEach`
// with "the stub HOME must be in effect" — so both are stubbed.
const HOME_VARS = ["HOME", "USERPROFILE"] as const;
const realHomeVars = HOME_VARS.map((key) => [key, process.env[key]] as const);
let home: string;
let cwd: string;
let transcript: string;
let store: FakeStore;
let logs: string[];
let watcher: Watcher | undefined;
let sequence = 0;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "keepundo-tw-"));
  for (const key of HOME_VARS) {
    process.env[key] = home;
  }
  cwd = path.join(home, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const sessionDir = sessionDirFor(cwd);
  assert.ok(sessionDir.startsWith(home), "the stub HOME must be in effect");
  fs.mkdirSync(sessionDir, { recursive: true });
  transcript = path.join(sessionDir, "session.jsonl");
  store = new FakeStore();
  logs = [];
});

afterEach(() => {
  watcher?.dispose();
  watcher = undefined;
  for (const [key, value] of realHomeVars) {
    // Assigning `undefined` would put the string "undefined" in the environment,
    // which is not the same as the variable being unset — and on Windows HOME is
    // normally unset.
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  fs.rmSync(home, { recursive: true, force: true });
});

/** Start watching, establishing "everything already there is history". */
function attach(): Watcher {
  watcher = new TranscriptWatcher(cwd, store, (m) => logs.push(m));
  watcher.tick();
  return watcher;
}

/**
 * Wait for the reconstruction debounce. Registration is deliberately deferred
 * until the *transcript* has gone quiet, so nothing is observable before then.
 */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 900));

function textLine(text: string): string {
  return `${JSON.stringify({
    timestamp: new Date(1_800_000_000_000).toISOString(),
    message: { content: [{ type: "text", text }] },
  })}\n`;
}

/** A tool call and its successful result, which is what commits the edit. */
function edit(file: string, oldString: string, newString: string): string {
  const id = `use_${++sequence}`;
  const at = 1_800_000_000_000 + sequence * 1000;
  return (
    `${JSON.stringify({
      timestamp: new Date(at).toISOString(),
      message: {
        content: [
          {
            type: "tool_use",
            id,
            name: "Edit",
            input: {
              file_path: file,
              old_string: oldString,
              new_string: newString,
            },
          },
        ],
      },
    })}\n` +
    `${JSON.stringify({
      timestamp: new Date(at + 1).toISOString(),
      message: {
        content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
      },
    })}\n`
  );
}

describe("TranscriptWatcher: oversized lines", () => {
  it("keeps reading after a line larger than the chunk size", async () => {
    // The failure this replaces was total and silent. `consume` read at most 1 MiB
    // and required a newline inside that window; finding none it returned *without
    // advancing the offset*, so every later tick re-read the same megabyte — and
    // every edit for the rest of the session was invisible, with no error, no log
    // line and no warning. Claude reading a 1.5 MB lockfile is enough to trigger
    // it, and the largest single line in the transcripts on this machine is already
    // 756 KB.
    const target = path.join(cwd, "app.ts");
    fs.writeFileSync(target, "const port = 9090;\n");
    attach();

    fs.appendFileSync(transcript, textLine("x".repeat(2 * 1024 * 1024)));
    fs.appendFileSync(transcript, edit(target, "8080", "9090"));
    watcher!.tick();
    await settle();

    assert.deepEqual(
      store.registered.map((r) => r.baseline),
      ["const port = 8080;\n"],
      "the edit after the oversized line must still be ingested"
    );
    assert.ok(
      logs.some((l) => l.includes("oversized")),
      "and the skip must be logged rather than silent"
    );
  });

  it("waits for a partial final line instead of skipping it", async () => {
    // The mirror case, which the old code got right and the fix must not break: a
    // read window that covers the whole tail and finds no newline means the last
    // line is still being appended.
    const target = path.join(cwd, "app.ts");
    fs.writeFileSync(target, "b\n");
    attach();

    const whole = edit(target, "a", "b");
    const cut = whole.indexOf("\n") - 5; // guaranteed inside the first line
    assert.ok(cut > 0);
    fs.appendFileSync(transcript, whole.slice(0, cut));
    watcher!.tick();
    await settle();
    assert.equal(store.registered.length, 0, "nothing complete to ingest yet");

    fs.appendFileSync(transcript, whole.slice(cut));
    watcher!.tick();
    await settle();
    assert.deepEqual(
      store.registered.map((r) => r.baseline),
      ["a\n"],
      "and it is ingested once the line is complete"
    );
  });
});

describe("TranscriptWatcher: offset arithmetic", () => {
  it("does not drift when it attaches inside a multi-byte character", async () => {
    // The offset used to be derived from the *decoded* string, which only matches
    // the bytes consumed when the read began on a character boundary. Attaching at
    // a raw `stat().size` can land inside a 2-byte sequence, whose orphan
    // continuation byte decodes to U+FFFD — three bytes — so the recorded offset
    // overshot the real line boundary, the next line started part-way in, failed to
    // parse, and was dropped in silence. A dropped edit is precisely the case where
    // reconstruction still verifies and still returns the wrong baseline: here the
    // user's own `AAA` would be replaced in the recorded "original" by Claude's
    // `BBB`, and Undo would write that back.
    const target = path.join(cwd, "app.ts");
    fs.writeFileSync(target, "BBB\nDDD\n");

    const history = textLine("città più però àèìòù");
    fs.writeFileSync(transcript, history);
    const accent = Buffer.from(history, "utf8").indexOf(
      Buffer.from("à", "utf8")
    );
    assert.ok(accent > 0);
    // Attach with the file truncated mid-character, then let the rest land.
    fs.truncateSync(transcript, accent + 1);
    attach();
    fs.writeFileSync(transcript, history);

    fs.appendFileSync(transcript, edit(target, "AAA", "BBB"));
    fs.appendFileSync(transcript, edit(target, "CCC", "DDD"));
    watcher!.tick();
    await settle();

    assert.deepEqual(
      store.registered.map((r) => r.baseline),
      ["AAA\nCCC\n"],
      "both edits must be seen, so the baseline is the user's own content"
    );
  });

  it("drains a backlog larger than one chunk in a single tick", async () => {
    // Advancing one chunk per tick means the backlog is consumed at the *poll*
    // rate, which backs off to 30 s exactly when nothing appears to be happening.
    const target = path.join(cwd, "app.ts");
    fs.writeFileSync(target, "final\n");
    attach();

    const filler = textLine("y".repeat(4000));
    let bulk = "";
    while (bulk.length < 3 * 1024 * 1024) {
      bulk += filler;
    }
    fs.appendFileSync(transcript, bulk);
    fs.appendFileSync(transcript, edit(target, "start", "final"));
    watcher!.tick();
    await settle();

    assert.deepEqual(
      store.registered.map((r) => r.baseline),
      ["start\n"],
      "the edit at the end of a 3 MB backlog must be reached by this tick"
    );
  });
});
