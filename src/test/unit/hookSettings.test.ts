import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  extractScriptPath,
  hookCommand,
  inspectHooks,
  MATCHER,
  mergeHooks,
  stripHooks,
} from "../../detection/hookSettings";

// Realistic install layouts, because `isOurInstall` reasons about them: the
// directory has to sit under some editor's extensions root and outside the
// workspace, and those two facts are the whole security boundary.
const HOME = path.join(path.sep, "home", "u");
const STABLE = path.join(HOME, ".vscode", "extensions");
const INSIDERS = path.join(HOME, ".vscode-insiders", "extensions");
const EXT_V1 = path.join(STABLE, "FedeFluork.claude-keep-undo-0.1.4");
const EXT_V2 = path.join(STABLE, "FedeFluork.claude-keep-undo-0.1.5");
const EXT_INSIDERS = path.join(INSIDERS, "FedeFluork.claude-keep-undo-0.1.4");
const EXT_CHECKOUT = path.join(HOME, "dev", "claude-keep-undo");
const STATE = path.join(HOME, "storage", "ws-1");
const OTHER_STATE = path.join(HOME, "storage", "ws-2");
const REPO = path.join(path.sep, "workspace", "project");

describe("hookCommand", () => {
  it("passes the state directory explicitly", () => {
    // Claude Code's cwd is not the folder VS Code has open whenever `claude`
    // was launched from a subdirectory, so the destination cannot be inferred.
    const command = hookCommand(EXT_V1, STATE, "pre");
    assert.ok(command.includes("keepundo-hook.mjs"));
    assert.ok(command.includes(" pre "));
    assert.ok(command.includes(`--state "${STATE}"`));
  });

  it("never mentions the repository", () => {
    // The command is machine-local; nothing about it belongs in a committed file.
    assert.ok(!hookCommand(EXT_V1, STATE, "post").includes(REPO));
  });
});

describe("extractScriptPath", () => {
  it("reads a quoted path", () => {
    assert.equal(
      extractScriptPath(`node "/a b/hooks/keepundo-hook.mjs" pre`),
      "/a b/hooks/keepundo-hook.mjs"
    );
  });

  it("reads an unquoted path", () => {
    assert.equal(
      extractScriptPath("node /a/hooks/keepundo-hook.mjs post"),
      "/a/hooks/keepundo-hook.mjs"
    );
  });

  it("returns undefined for an unrelated command", () => {
    assert.equal(extractScriptPath("echo hello"), undefined);
  });
});

describe("mergeHooks", () => {
  it("adds both hooks to an empty settings object", () => {
    const merged = mergeHooks({}, EXT_V1, STATE) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    assert.equal(merged.hooks.PreToolUse.length, 1);
    assert.equal(merged.hooks.PostToolUse.length, 1);
    assert.equal(
      merged.hooks.PreToolUse[0].hooks[0].command,
      hookCommand(EXT_V1, STATE, "pre")
    );
  });

  it("preserves unrelated settings and unrelated hooks", () => {
    const before = {
      permissions: { allow: ["Bash(ls:*)"] },
      env: { FOO: "bar" },
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] },
        ],
        SessionStart: [{ hooks: [{ type: "command", command: "echo start" }] }],
      },
    };
    const merged = mergeHooks(before, EXT_V1, STATE) as typeof before;

    assert.deepEqual(merged.permissions, { allow: ["Bash(ls:*)"] });
    assert.deepEqual(merged.env, { FOO: "bar" });
    assert.equal(merged.hooks.SessionStart.length, 1);
    assert.equal(merged.hooks.PreToolUse[0].hooks[0].command, "echo hi");
    assert.equal(merged.hooks.PreToolUse.length, 2);
  });

  it("is idempotent and replaces a stale install path", () => {
    const once = mergeHooks({}, EXT_V1, STATE);
    const twice = mergeHooks(once, EXT_V1, STATE);
    assert.deepEqual(twice, once);

    const upgraded = mergeHooks(once, EXT_V2, STATE) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    assert.equal(upgraded.hooks.PreToolUse.length, 1);
    assert.equal(
      upgraded.hooks.PreToolUse[0].hooks[0].command,
      hookCommand(EXT_V2, STATE, "pre")
    );
  });
});

describe("mergeHooks — matcher reuse", () => {
  it("adds to an existing matcher instead of appending a duplicate block", () => {
    const before = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit|Write|MultiEdit",
            hooks: [{ type: "command", command: "echo mine" }],
          },
        ],
      },
    };
    const merged = mergeHooks(before, EXT_V1, STATE) as {
      hooks: Record<string, { matcher?: string; hooks: unknown[] }[]>;
    };
    assert.equal(merged.hooks.PreToolUse.length, 1);
    assert.equal(merged.hooks.PreToolUse[0].hooks.length, 2);
  });
});

describe("stripHooks", () => {
  it("removes only our entries", () => {
    const before = {
      permissions: { allow: [] },
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] },
        ],
      },
    };
    const withOurs = mergeHooks(before, EXT_V1, STATE);
    const stripped = stripHooks(withOurs) as typeof before;
    assert.deepEqual(stripped, before);
  });

  it("drops the hooks key when nothing else is left", () => {
    const stripped = stripHooks(mergeHooks({ env: {} }, EXT_V1, STATE));
    assert.deepEqual(stripped, { env: {} });
  });
});

describe("inspectHooks", () => {
  it("reports missing when nothing is installed", () => {
    assert.equal(inspectHooks({}, EXT_V1, STATE), "missing");
    assert.equal(inspectHooks(undefined, EXT_V1, STATE), "missing");
  });

  it("reports ok for a current install", () => {
    const settings = mergeHooks({}, EXT_V1, STATE);
    assert.equal(inspectHooks(settings, EXT_V1, STATE), "ok");
  });

  it("reports stale after an extension update", () => {
    // The install directory is version-stamped, so the recorded command points
    // at a path that no longer exists — the failure the old substring check hid.
    const settings = mergeHooks({}, EXT_V1, STATE);
    assert.equal(inspectHooks(settings, EXT_V2, STATE), "stale");
  });

  it("reports stale when the state directory changed", () => {
    const settings = mergeHooks({}, EXT_V1, STATE);
    assert.equal(inspectHooks(settings, EXT_V1, OTHER_STATE), "stale");
  });

  it("reports foreign for a hook script outside the extension", () => {
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit",
            hooks: [
              {
                type: "command",
                command: `node "${path.join(REPO, "keepundo-hook.mjs")}" pre`,
              },
            ],
          },
        ],
      },
    };
    assert.equal(inspectHooks(settings, EXT_V1, STATE), "foreign");
  });

  it("repairs, rather than distrusts, an install from another VS Code build", () => {
    // Stable, Insiders, Cursor and a source checkout each have their own
    // extensions root, and the sibling test used to require the *same* one. So
    // opening the same project in a second build called a perfectly valid
    // registration somebody else's script: a security-flavoured warning on every
    // activation, and — since a foreign install is never repaired — hooks left
    // pointing at the other build's state directory, so that window reviewed
    // nothing at all, permanently.
    const settings = mergeHooks({}, EXT_V1, STATE, REPO);
    assert.equal(inspectHooks(settings, EXT_INSIDERS, STATE, REPO), "stale");
    assert.equal(inspectHooks(settings, EXT_CHECKOUT, STATE, REPO), "stale");
  });

  it("still refuses a script the project ships, however it is named", () => {
    // The reason the check exists. Claude Code executes this command, so a
    // repository that plants a plausible-looking install path inside the workspace
    // must never be adopted — the workspace is excluded before the extensions-root
    // test can approve it.
    const planted = path.join(
      REPO,
      ".vscode",
      "extensions",
      "FedeFluork.claude-keep-undo-9.9.9",
      "hooks",
      "keepundo-hook.mjs"
    );
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: MATCHER,
            hooks: [{ type: "command", command: `node "${planted}" pre` }],
          },
        ],
      },
    };
    assert.equal(inspectHooks(settings, EXT_V1, STATE, REPO), "foreign");
  });
});

describe("inspectHooks: half-wired registrations", () => {
  // All five of these used to report `ok`, because the check compared the flat set
  // of our command strings and threw away the event key and the matcher. Nothing
  // ever repaired them, and the extension logged that real-time detection was
  // active. The first is the worst: with both commands under PreToolUse the `post`
  // hook runs *before* the edit, promotes a baseline identical to the file on disk,
  // and every change resolves to nothing while `pending/` fills with verbatim
  // copies of the user's source.
  const pre = hookCommand(EXT_V1, STATE, "pre", REPO);
  const post = hookCommand(EXT_V1, STATE, "post", REPO);
  const entry = (command: string, matcher = MATCHER) => ({
    matcher,
    hooks: [{ type: "command", command }],
  });
  const check = (hooks: Record<string, unknown>) =>
    inspectHooks({ hooks }, EXT_V1, STATE, REPO);

  it("is the baseline for comparison: the real thing is ok", () => {
    assert.equal(
      check({ PreToolUse: [entry(pre)], PostToolUse: [entry(post)] }),
      "ok"
    );
  });

  it("rejects both commands under one event", () => {
    assert.equal(check({ PreToolUse: [entry(pre), entry(post)] }), "stale");
  });

  it("rejects the two events swapped", () => {
    assert.equal(
      check({ PreToolUse: [entry(post)], PostToolUse: [entry(pre)] }),
      "stale"
    );
  });

  it("rejects a rewritten matcher", () => {
    assert.equal(
      check({
        PreToolUse: [entry(pre, "Bash")],
        PostToolUse: [entry(post)],
      }),
      "stale"
    );
  });

  it("rejects a copy parked under an unrelated event", () => {
    assert.equal(
      check({ Stop: [entry(pre)], PostToolUse: [entry(post)] }),
      "stale"
    );
  });

  it("rejects a stray extra copy alongside a correct install", () => {
    assert.equal(
      check({
        PreToolUse: [entry(pre)],
        PostToolUse: [entry(post)],
        Stop: [entry(pre)],
      }),
      "stale"
    );
  });
});

describe("hook settings of an unexpected shape", () => {
  // Valid JSON, wrong shape: a single object where an array belongs is a plausible
  // hand-written mistake that Claude Code itself tolerates. Every one of these used
  // to throw — `matchers.map is not a function`, `(m.hooks ?? []).filter is not a
  // function`, `object is not iterable` — and the throw propagated out through
  // `hooksState` to abort `activate()` part-way, taking down the transcript channel
  // as well, which has nothing to do with hooks.
  const shapes: [string, unknown][] = [
    [
      "an event holding an object",
      { hooks: { PreToolUse: { matcher: "Bash" } } },
    ],
    [
      "a matcher whose hooks is an object",
      {
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: { type: "command", command: "./ci.sh" } },
          ],
        },
      },
    ],
    ["a null matcher entry", { hooks: { PreToolUse: [null] } }],
    ["hooks holding an array", { hooks: [] }],
    ["hooks holding a string", { hooks: "PreToolUse" }],
  ];

  for (const [name, settings] of shapes) {
    it(`classifies ${name} without throwing`, () => {
      assert.equal(inspectHooks(settings, EXT_V1, STATE, REPO), "missing");
      assert.doesNotThrow(() =>
        mergeHooks(settings as Record<string, unknown>, EXT_V1, STATE, REPO)
      );
      assert.doesNotThrow(() =>
        stripHooks(settings as Record<string, unknown>)
      );
    });
  }

  it("installs correctly on top of a malformed file", () => {
    const merged = mergeHooks(
      { hooks: { PreToolUse: { matcher: "Bash" } } },
      EXT_V1,
      STATE,
      REPO
    );
    assert.equal(inspectHooks(merged, EXT_V1, STATE, REPO), "ok");
  });

  it("never deletes a block it cannot parse", () => {
    // `stripHooks` moves *our* install out of the shared, committed settings file.
    // It used to return `{}` for this input — silently deleting a block from a file
    // the user had committed.
    const before = { hooks: { PreToolUse: { matcher: "Bash" } } };
    assert.deepEqual(stripHooks(before), before);
  });

  it("keeps an unparseable sibling entry when stripping ours out", () => {
    const theirs = {
      matcher: "Bash",
      hooks: { type: "command", command: "./ci.sh" },
    };
    const settings = {
      hooks: {
        PreToolUse: [
          theirs,
          {
            matcher: MATCHER,
            hooks: [
              { type: "command", command: hookCommand(EXT_V1, STATE, "pre") },
            ],
          },
        ],
      },
    };
    const stripped = stripHooks(settings) as {
      hooks: { PreToolUse: unknown[] };
    };
    assert.deepEqual(stripped.hooks.PreToolUse, [theirs]);
  });
});
