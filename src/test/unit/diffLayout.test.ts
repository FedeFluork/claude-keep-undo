/**
 * Multi-window tests for the diff-editor overrides.
 *
 * `DiffLayoutController` borrows two of the user's own settings, and its
 * crash-recovery records live in globalState — which every VS Code window on the
 * machine shares. The failures that mattered were all *between* windows: a second
 * window recording the first one's override as "the user's value", a newly
 * activating window yanking a live sibling's override out mid-review, a failed
 * release letting the next override adopt its own leftover. None of that is
 * reachable from a single-window integration test.
 *
 * So this drives the compiled controller with a stubbed `vscode`: one settings
 * store, one memento, and one config-event bus shared by every "window", which is
 * exactly the coupling that made the real thing lose data. `Module._load` is
 * intercepted because `vscode` only resolves inside the extension host.
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { beforeEach, describe, it } from "node:test";

type Scope = "global" | "workspace" | "workspaceFolder";
type ConfigEvent = { affectsConfiguration(section: string): boolean };

const settings: Record<Scope, Record<string, unknown>> = {
  global: {},
  workspace: {},
  workspaceFolder: {},
};
const memento = new Map<string, Record<string, unknown>>();
let listeners: ((e: ConfigEvent) => void)[] = [];
const warnings: string[] = [];
let failWrites = false;
let sessionId = "unset";
let workspaceId = "";

const Target = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;
const scopeOf = (target: number): Scope =>
  target === Target.WorkspaceFolder
    ? "workspaceFolder"
    : target === Target.Workspace
      ? "workspace"
      : "global";

const vscodeStub = {
  get env() {
    return { sessionId };
  },
  ConfigurationTarget: Target,
  TabInputTextDiff: class {},
  workspace: {
    workspaceFile: undefined,
    get workspaceFolders() {
      return [{ uri: { toString: () => workspaceId } }];
    },
    getConfiguration(section: string) {
      const full = (key: string) => `${section}.${key}`;
      return {
        get(key: string) {
          for (const scope of [
            "workspaceFolder",
            "workspace",
            "global",
          ] as Scope[]) {
            const value = settings[scope][full(key)];
            if (value !== undefined) {
              return value;
            }
          }
          return undefined;
        },
        inspect(key: string) {
          return {
            globalValue: settings.global[full(key)],
            workspaceValue: settings.workspace[full(key)],
            workspaceFolderValue: settings.workspaceFolder[full(key)],
          };
        },
        update(key: string, value: unknown, target: number): Promise<void> {
          if (failWrites) {
            // What VS Code does when settings.json has a syntax error, is
            // read-only, or the host is shutting down.
            return Promise.reject(
              new Error("Unable to write into user settings.")
            );
          }
          const scope = scopeOf(target);
          if (value === undefined) {
            delete settings[scope][full(key)];
          } else {
            settings[scope][full(key)] = value;
          }
          // Every window is notified, not just the one that wrote.
          for (const listener of [...listeners]) {
            listener({
              affectsConfiguration: (s) => s === full(key) || s === section,
            });
          }
          return Promise.resolve();
        },
      };
    },
    onDidChangeConfiguration(cb: (e: ConfigEvent) => void) {
      listeners.push(cb);
      return {
        dispose() {
          listeners = listeners.filter((l) => l !== cb);
        },
      };
    },
  },
  window: {
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    tabGroups: {
      activeTabGroup: { activeTab: undefined },
      all: [],
      onDidChangeTabs: () => ({ dispose() {} }),
      onDidChangeTabGroups: () => ({ dispose() {} }),
    },
    showWarningMessage(message: string) {
      warnings.push(message);
      return Promise.resolve(undefined);
    },
  },
};

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
interface LoadableModule {
  _load: Loader;
}
const loader = Module as unknown as LoadableModule;
const realLoad: Loader = loader._load.bind(Module);
loader._load = (request: string, parent: unknown, isMain: boolean) =>
  request === "vscode" ? vscodeStub : realLoad(request, parent, isMain);

interface Controller {
  notifyOpening(): Promise<void>;
  flush(): Promise<void>;
}
type ControllerCtor = new (context: { globalState: unknown }) => Controller;

// Loaded through `_load` on purpose: an `import` is hoisted above the stub above,
// and `vscode` only resolves inside the extension host.
const { DiffLayoutController } = loader._load(
  "../../ui/diffLayout",
  module,
  false
) as { DiffLayoutController: ControllerCtor };

function openWindow(session: string, workspace: string): Controller {
  sessionId = session;
  workspaceId = workspace;
  return new DiffLayoutController({
    globalState: {
      get: (k: string) => memento.get(k),
      keys: () => [...memento.keys()],
      update: (k: string, v: Record<string, unknown> | undefined) => {
        if (v === undefined) {
          memento.delete(k);
        } else {
          memento.set(k, v);
        }
        return Promise.resolve();
      },
    },
  });
}

/**
 * A force-quit: the host is gone, so its listeners stop firing and its heartbeat
 * stops renewing. `dispose()` cannot model this — it flushes, which is the clean
 * shutdown that never loses anything.
 *
 * Drain first. A window reacts to its own config writes on an internal promise
 * queue, and those follow-ups outlive `notifyOpening()`; leaving them pending
 * would let a "crashed" window keep writing, which no real crash does.
 */
async function crashEveryWindow(): Promise<void> {
  await settle();
  listeners = [];
  for (const [key, value] of memento) {
    memento.set(key, { ...value, ts: Date.now() - 120_000 });
  }
}

function borrowed(scope: Scope = "global"): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(settings[scope]).filter(([k]) => k.startsWith("diffEditor."))
  );
}

const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  for (const scope of ["global", "workspace", "workspaceFolder"] as Scope[]) {
    settings[scope] = {};
  }
  // The default, and what makes `renderSideBySide` get forced at all.
  settings.global["claudeKeepUndo.diffMode"] = "inline";
  memento.clear();
  listeners = [];
  warnings.length = 0;
  failWrites = false;
});

describe("DiffLayoutController across windows", () => {
  it("does not let a second window adopt the first one's override", async () => {
    // The record is one key in globalState, shared by every window, and `set()`
    // used to learn "the user's original" by reading the live config. With another
    // window already holding the override, that value *is* the override — so the
    // second window recorded it as the user's choice and faithfully wrote it back
    // for good, with Settings Sync propagating it to every machine.
    const a = openWindow("session-a", "file:///P1");
    await a.notifyOpening();
    const held = borrowed();
    assert.deepEqual(held, {
      "diffEditor.renderSideBySide": false,
      "diffEditor.codeLens": true,
    });

    const b = openWindow("session-b", "file:///P2");
    await b.notifyOpening();

    const owners = new Set([...memento.values()].map((v) => v.session));
    assert.deepEqual(
      [...owners],
      ["session-a"],
      "the second window must not clobber the first one's recovery record"
    );

    await b.flush();
    assert.deepEqual(
      borrowed(),
      held,
      "releasing the window that never overrode anything must change nothing"
    );
    await a.flush();
  });

  it("restores an override left behind by a window that crashed", async () => {
    const a = openWindow("session-a", "file:///P1");
    await a.notifyOpening();
    assert.equal(borrowed()["diffEditor.renderSideBySide"], false);

    await crashEveryWindow();

    // The next window to activate is what repairs it.
    const b = openWindow("session-b", "file:///P2");
    await settle();

    assert.deepEqual(borrowed(), {}, "the user's settings must be clean again");
    assert.equal(memento.size, 0, "and the spent record must be dropped");
    await b.flush();
  });

  it("leaves a live sibling's override — and its record — alone", async () => {
    // `restoreOrphaned` treated presence in globalState as proof of orphanhood, and
    // exempted global-scope records from the workspace guard, so *any* activating
    // window replayed a live sibling's record: the open diff visibly flipped out of
    // inline mid-review, and the unconditional delete that followed raced the
    // holder into leaving the override applied with no record at all.
    const a = openWindow("session-a", "file:///P1");
    await a.notifyOpening();
    const held = borrowed();
    const records = memento.size;

    const b = openWindow("session-b", "file:///P2");
    await settle();

    assert.deepEqual(borrowed(), held, "the review must not be disturbed");
    assert.ok(memento.size >= records, "the recovery record must survive");
    await a.flush();
    await b.flush();
  });

  it("never replays another project's workspace-scoped record", async () => {
    // A workspace record replayed elsewhere writes the wrong project's
    // settings.json — which for a committed .vscode/settings.json means editing the
    // repository.
    settings.workspace["diffEditor.renderSideBySide"] = true;
    const p1 = openWindow("session-p1", "file:///P1");
    await p1.notifyOpening();
    await crashEveryWindow();

    const p2 = openWindow("session-p2", "file:///P2");
    await p2.notifyOpening();
    await settle();

    assert.ok(
      [...memento.values()].some(
        (v) => v.scope === "workspace" && v.workspace === "file:///P1"
      ),
      "P1's record must be left for the window that owns it"
    );
    await p2.flush();
  });

  it("keeps the user's value after a release whose write failed", async () => {
    // The release used to clear `applied` *before* the write, so a rejected write
    // left the override on disk with the state saying otherwise. The next override
    // then re-inspected the config, read its own leftover, and recorded that as the
    // user's value — erasing their real setting from disk and from the record.
    settings.global["diffEditor.renderSideBySide"] = true;
    const a = openWindow("session-a", "file:///P1");
    await a.notifyOpening();
    assert.equal(borrowed()["diffEditor.renderSideBySide"], false);

    failWrites = true;
    await a.flush();
    assert.ok(warnings.length > 0, "a failed write must not be swallowed");

    // The user fixes their settings.json; a later diff opens and closes.
    failWrites = false;
    await a.notifyOpening();
    await a.flush();

    assert.equal(
      borrowed()["diffEditor.renderSideBySide"],
      true,
      "the user's deliberate value must come back"
    );
  });

  it("releases both settings even when the first release fails", async () => {
    // One shared `.catch` meant a failure releasing `renderSideBySide` skipped
    // `codeLens` entirely, leaving it overridden with no further attempt.
    const a = openWindow("session-a", "file:///P1");
    await a.notifyOpening();
    assert.equal(borrowed()["diffEditor.codeLens"], true);

    failWrites = true;
    await a.flush();
    failWrites = false;
    await a.flush();

    assert.deepEqual(borrowed(), {}, "both overrides must be released");
  });

  it("writes nothing when the user already has the value we want", async () => {
    // The narrowest fix of all: no write means no record, no shared key to collide
    // over, and nothing to restore if the window dies.
    settings.global["diffEditor.renderSideBySide"] = false;
    settings.global["diffEditor.codeLens"] = true;
    const a = openWindow("session-a", "file:///P1");
    await a.notifyOpening();

    assert.equal(memento.size, 0, "there was nothing to override");
    await a.flush();
    assert.deepEqual(borrowed(), {
      "diffEditor.renderSideBySide": false,
      "diffEditor.codeLens": true,
    });
  });
});
