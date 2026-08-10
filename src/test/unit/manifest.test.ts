import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

/**
 * Guards on package.json.
 *
 * The menu contributions depend on context keys (`originalResourceScheme`,
 * `commentController`, `commentThread`, `scmProvider`) that VS Code's own
 * extensions use but that are not listed in the public *when clause contexts*
 * reference. Nothing checks them at compile or package time, so a typo — or a
 * command renamed on one side only — silently makes the Keep/Undo buttons
 * disappear with no error anywhere. These assertions catch the self-inflicted
 * half of that.
 */

interface ConfigurationCategory {
  id?: string;
  title: string;
  order?: number;
  properties: Record<string, Record<string, unknown>>;
}

interface WalkthroughStep {
  id: string;
  title: string;
  description: string;
  media?: { markdown?: string; image?: string; svg?: string };
  completionEvents?: string[];
}

interface Manifest {
  icon?: string;
  engines: Record<string, string>;
  capabilities?: Record<string, { supported?: boolean }>;
  contributes: {
    commands: { command: string }[];
    keybindings?: {
      command: string;
      key: string;
      mac?: string;
      when?: string;
    }[];
    menus: Record<string, { command: string; when?: string; group?: string }[]>;
    configuration: ConfigurationCategory[];
    viewsWelcome: { view: string; when?: string; contents: string }[];
    walkthroughs?: { id: string; steps: WalkthroughStep[] }[];
  };
}

const root = path.resolve(__dirname, "..", "..", "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8")
) as Manifest;

const declared = new Set(manifest.contributes.commands.map((c) => c.command));

/** Every configured property, flattened across the settings categories. */
function properties(): Record<string, Record<string, unknown>> {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const category of manifest.contributes.configuration) {
    for (const [key, value] of Object.entries(category.properties)) {
      merged[key] = value;
    }
  }
  return merged;
}

describe("manifest: commands", () => {
  it("declares every command referenced by a menu", () => {
    const missing: string[] = [];
    for (const [menu, items] of Object.entries(manifest.contributes.menus)) {
      for (const item of items) {
        if (!declared.has(item.command)) {
          missing.push(`${menu} -> ${item.command}`);
        }
      }
    }
    assert.deepEqual(missing, []);
  });

  it("declares every command referenced by a keybinding", () => {
    for (const binding of manifest.contributes.keybindings ?? []) {
      assert.ok(
        declared.has(binding.command),
        `${binding.command} has a keybinding but is not declared`
      );
    }
  });

  it("scopes every keybinding to a file we are actually tracking", () => {
    const bindings = manifest.contributes.keybindings ?? [];
    assert.ok(bindings.length > 0, "no keybindings contributed");
    for (const binding of bindings) {
      // An unscoped binding takes the key away from VS Code everywhere, in
      // every file, forever. Ours are only meant to exist inside a file Claude
      // has changed.
      assert.match(
        binding.when ?? "",
        /claudeKeepUndo\.activeDiffTracked/,
        `${binding.key} is not scoped to a tracked file`
      );
    }
  });

  it("declares a mac binding wherever it declares a ctrl+alt one", () => {
    for (const binding of manifest.contributes.keybindings ?? []) {
      if (binding.key.startsWith("ctrl+alt+")) {
        assert.ok(binding.mac, `${binding.key} has no mac equivalent`);
      }
    }
  });
});

describe("manifest: in-file review menus", () => {
  it("puts Keep/Undo in the Quick Diff widget, scoped to our scheme", () => {
    const entries = manifest.contributes.menus["scm/change/title"] ?? [];
    const commands = entries.map((e) => e.command);
    assert.ok(commands.includes("claudeKeepUndo.keepChange"));
    assert.ok(commands.includes("claudeKeepUndo.undoChange"));
    for (const entry of entries) {
      // Without this clause our actions would also show on Git's changes.
      assert.equal(entry.when, "originalResourceScheme == claude-baseline");
    }
  });

  it("puts Keep/Undo in the comment thread toolbar", () => {
    const entries =
      manifest.contributes.menus["comments/commentThread/title"] ?? [];
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      assert.match(entry.when ?? "", /commentController == claudeKeepUndo/);
      assert.match(entry.when ?? "", /commentThread == claudeHunk/);
    }
  });

  it("puts Keep/Undo on the line-number context menu", () => {
    const entries =
      manifest.contributes.menus["editor/lineNumber/context"] ?? [];
    const commands = entries.map((e) => e.command);
    assert.ok(commands.includes("claudeKeepUndo.keepAtLine"));
    assert.ok(commands.includes("claudeKeepUndo.undoAtLine"));
  });

  it("does not pretend a when clause can hide the menu on the baseline pane", () => {
    // VS Code binds `resourceScheme` once per editor *group*, from the diff's
    // modified side, so it reads `file` on BOTH panes of a Claude diff. A
    // `resourceScheme == file` clause here looks like a guard and does nothing.
    // The real guard is `resolveLineArg` refusing the baseline scheme, which is
    // where the wrong-hunk defect (B-02) is actually prevented.
    const entries =
      manifest.contributes.menus["editor/lineNumber/context"] ?? [];
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      assert.doesNotMatch(entry.when ?? "", /resourceScheme/);
    }
  });

  it("scopes the Source Control menus to our provider", () => {
    for (const menu of ["scm/title", "scm/resourceState/context"]) {
      const entries = manifest.contributes.menus[menu] ?? [];
      assert.ok(entries.length > 0, `${menu} has no entries`);
      for (const entry of entries) {
        assert.match(entry.when ?? "", /scmProvider == claudeKeepUndo/);
      }
    }
  });

  it("hides the internal commands from the command palette", () => {
    const hidden = new Set(
      (manifest.contributes.menus.commandPalette ?? [])
        .filter((e) => e.when === "false")
        .map((e) => e.command)
    );
    for (const command of [
      "claudeKeepUndo.keepChange",
      "claudeKeepUndo.undoChange",
      "claudeKeepUndo.keepAtLine",
      "claudeKeepUndo.undoAtLine",
      "claudeKeepUndo.keepHunk",
      "claudeKeepUndo.undoHunk",
    ]) {
      assert.ok(hidden.has(command), `${command} should be palette-hidden`);
    }
  });

  it("only offers the Explorer entry when there is something to open", () => {
    // `resourceScheme == file` alone is every file in the project, and on all
    // but a handful the command answers with an apology.
    const entries = manifest.contributes.menus["explorer/context"] ?? [];
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      assert.match(entry.when ?? "", /claudeKeepUndo\.hasChanges/);
      assert.match(entry.when ?? "", /claudeKeepUndo\.explorerMenu/);
    }
  });

  it("offers Install Hooks as a button on unreviewable rows, not as the click", () => {
    const entries = manifest.contributes.menus["view/item/context"] ?? [];
    const install = entries.find(
      (e) => e.command === "claudeKeepUndo.installHooks"
    );
    assert.ok(install, "no install action on the tree rows");
    assert.match(install.when ?? "", /viewItem == claudeUnreviewable/);
  });
});

describe("manifest: first run", () => {
  it("does not offer to install hooks that are already installed", () => {
    const blocks = manifest.contributes.viewsWelcome.filter(
      (w) => w.view === "claudeKeepUndo.changes"
    );
    assert.ok(blocks.length >= 2, "expected an installed and a missing state");
    for (const block of blocks) {
      assert.ok(block.when, "every welcome block must be conditional");
    }
    const offering = blocks.filter((b) =>
      b.contents.includes("command:claudeKeepUndo.installHooks")
    );
    assert.equal(offering.length, 1);
    assert.match(offering[0].when ?? "", /^!claudeKeepUndo\.hooksInstalled$/);
  });

  it("ships every walkthrough media file it references", () => {
    const walkthroughs = manifest.contributes.walkthroughs ?? [];
    assert.ok(walkthroughs.length > 0, "no walkthrough contributed");
    for (const walkthrough of walkthroughs) {
      assert.ok(walkthrough.steps.length > 0);
      for (const step of walkthrough.steps) {
        const media =
          step.media?.markdown ?? step.media?.image ?? step.media?.svg;
        assert.ok(media, `${step.id} has no media`);
        assert.ok(
          fs.existsSync(path.join(root, media)),
          `${media} is referenced but missing`
        );
      }
    }
  });

  it("only completes a walkthrough step on events it can actually emit", () => {
    const known = new Set([
      ...[...declared].map((c) => `onCommand:${c}`),
      "onContext:claudeKeepUndo.hooksInstalled",
      "onContext:claudeKeepUndo.hasChanges",
    ]);
    for (const walkthrough of manifest.contributes.walkthroughs ?? []) {
      for (const step of walkthrough.steps) {
        for (const event of step.completionEvents ?? []) {
          assert.ok(known.has(event), `${step.id}: unknown event ${event}`);
        }
      }
    }
  });
});

describe("manifest: publishing metadata", () => {
  it("ships an icon that exists", () => {
    const icon = manifest.icon;
    assert.ok(icon, "no icon declared");
    assert.ok(fs.existsSync(path.join(root, icon)), `${icon} is missing`);
  });

  it("declares its workspace-trust and virtual-workspace stance", () => {
    assert.equal(manifest.capabilities?.untrustedWorkspaces?.supported, false);
    assert.equal(manifest.capabilities?.virtualWorkspaces?.supported, false);
  });

  it("pins the vscode types to the declared engine", () => {
    const engine = manifest.engines.vscode.replace(/^[^\d]*/, "");
    const types = (
      JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
        devDependencies: Record<string, string>;
      }
    ).devDependencies["@types/vscode"];
    // An exact pin: a caret range here silently allows compiling against APIs
    // that do not exist in the version users are told is supported.
    assert.equal(types, engine);
  });

  it("lets the badge hold two symbols, including astral emoji", () => {
    // maxLength counts UTF-16 code units, so a limit of 2 makes a single astral
    // emoji fill the budget while the decoration provider slices two *code
    // points*. The schema has to allow what the code is written to render.
    const badge = properties()["claudeKeepUndo.badge"] as { maxLength: number };
    assert.ok(badge.maxLength >= [..."🔥🔥"].length * 2);
  });

  it("declares the workspace-scoping setting the detectors read", () => {
    const setting = properties()["claudeKeepUndo.trackOutsideWorkspace"] as
      { type: string; default: boolean } | undefined;
    assert.ok(setting, "claudeKeepUndo.trackOutsideWorkspace is not declared");
    assert.equal(setting.type, "boolean");
    assert.equal(setting.default, false);
  });

  it("declares a settings default for every inline review mode", () => {
    const setting = properties()["claudeKeepUndo.inlineReview"] as {
      enum: string[];
      enumDescriptions: string[];
      default: string;
    };
    assert.deepEqual(setting.enum, ["quickDiff", "comments", "both", "off"]);
    assert.equal(setting.enumDescriptions.length, setting.enum.length);
    assert.ok(setting.enum.includes(setting.default));
  });
});

describe("manifest: settings organisation", () => {
  it("groups the settings and orders the groups", () => {
    const categories = manifest.contributes.configuration;
    assert.ok(Array.isArray(categories), "configuration must be grouped");
    assert.ok(categories.length >= 3);
    const orders = categories.map((c) => c.order);
    assert.deepEqual(
      orders,
      [...orders].sort((a, b) => (a ?? 0) - (b ?? 0)),
      "categories must declare an increasing order"
    );
    // The two that change what the user sees must not sit below the detection
    // toggles just because they were added later.
    assert.equal(categories[0].title, "Review surfaces");
  });

  it("gives every property an explicit order within its group", () => {
    for (const category of manifest.contributes.configuration) {
      for (const [key, value] of Object.entries(category.properties)) {
        assert.equal(
          typeof value.order,
          "number",
          `${key} has no order in the Settings editor`
        );
      }
    }
  });

  it("declares no property twice", () => {
    const seen = new Set<string>();
    for (const category of manifest.contributes.configuration) {
      for (const key of Object.keys(category.properties)) {
        assert.ok(!seen.has(key), `${key} is declared in two categories`);
        seen.add(key);
      }
    }
  });

  it("labels and describes every enum value", () => {
    for (const [key, value] of Object.entries(properties())) {
      const options = value.enum as string[] | undefined;
      if (!options) {
        continue;
      }
      assert.equal(
        (value.enumDescriptions as string[] | undefined)?.length,
        options.length,
        `${key} is missing an enum description`
      );
      assert.equal(
        (value.enumItemLabels as string[] | undefined)?.length,
        options.length,
        `${key} is missing an enum label`
      );
      assert.ok(
        options.includes(value.default as string),
        `${key} defaults to a value it does not offer`
      );
    }
  });
});
