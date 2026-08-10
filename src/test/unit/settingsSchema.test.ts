import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  PRESETS,
  SECTION,
  SETTING_GROUPS,
  allSettings,
  findSetting,
} from "../../settingsSchema";

/**
 * The settings exist in two places that must not drift: `package.json`, which
 * the Settings editor and Settings Sync read, and {@link SETTING_GROUPS}, which
 * the webview panel renders and the typed readers take their defaults from.
 *
 * Nothing in the toolchain relates the two — a key renamed on one side only
 * produces a panel control that writes to a setting nobody reads, with no error
 * anywhere. This is that check.
 */

interface Category {
  properties: Record<
    string,
    {
      type: string;
      default: unknown;
      enum?: string[];
      maxLength?: number;
      items?: { type: string };
    }
  >;
}

const root = path.resolve(__dirname, "..", "..", "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8")
) as { contributes: { configuration: Category[] } };

const declared = new Map(
  manifest.contributes.configuration.flatMap((c) =>
    Object.entries(c.properties)
  )
);

describe("settings schema", () => {
  it("declares every setting the panel renders", () => {
    for (const spec of allSettings()) {
      assert.ok(
        declared.has(`${SECTION}.${spec.key}`),
        `${spec.key} is in the panel but not in package.json`
      );
    }
  });

  it("renders every setting the manifest declares", () => {
    const known = new Set(allSettings().map((s) => `${SECTION}.${s.key}`));
    for (const key of declared.keys()) {
      assert.ok(known.has(key), `${key} is declared but the panel ignores it`);
    }
  });

  it("agrees with the manifest on type, default and choices", () => {
    for (const spec of allSettings()) {
      const declaration = declared.get(`${SECTION}.${spec.key}`);
      assert.ok(declaration);
      // The panel's vocabulary is not the manifest's: an `enum` is a string
      // constrained to a set, and a `list` is an array of them.
      const expectedType =
        spec.type === "enum"
          ? "string"
          : spec.type === "list"
            ? "array"
            : spec.type;
      assert.equal(declaration.type, expectedType, `${spec.key}: type`);
      assert.deepEqual(
        declaration.default,
        spec.default,
        `${spec.key}: default`
      );
      if (spec.type === "enum") {
        assert.deepEqual(
          [...(declaration.enum ?? [])].sort(),
          (spec.choices ?? []).map((c) => c.value).sort(),
          `${spec.key}: choices`
        );
      }
      if (spec.maxLength !== undefined) {
        assert.equal(declaration.maxLength, spec.maxLength, `${spec.key}: max`);
      }
    }
  });

  it("gives every setting a title and an explanation", () => {
    for (const spec of allSettings()) {
      assert.ok(spec.title.length > 0, `${spec.key} has no title`);
      // The panel exists to say what a surface costs. A setting with a one-word
      // description belongs in the Settings editor, not here.
      assert.ok(
        spec.detail.length > 40,
        `${spec.key} has no real explanation for the panel`
      );
      for (const choice of spec.choices ?? []) {
        assert.ok(choice.label.length > 0, `${spec.key}: unlabelled choice`);
        assert.ok(choice.detail.length > 0, `${spec.key}: undescribed choice`);
      }
    }
  });

  it("declares every list setting as an array of strings", () => {
    // Without `items` the Settings editor offers no way to add an entry, and
    // the panel would be the only place the setting could be edited at all.
    for (const spec of allSettings()) {
      if (spec.type !== "list") {
        continue;
      }
      const declaration = declared.get(`${SECTION}.${spec.key}`);
      assert.equal(declaration?.items?.type, "string", `${spec.key}: items`);
      assert.ok(Array.isArray(spec.default), `${spec.key}: default`);
    }
  });

  it("offers a command next to a setting only if that command exists", () => {
    const commands = new Set(
      (
        JSON.parse(
          fs.readFileSync(path.join(root, "package.json"), "utf8")
        ) as { contributes: { commands: { command: string }[] } }
      ).contributes.commands.map((c) => c.command)
    );
    for (const spec of allSettings()) {
      if (spec.action) {
        assert.ok(
          commands.has(spec.action.command),
          `${spec.key} offers ${spec.action.command}, which is not declared`
        );
      }
    }
  });

  it("names every group and never repeats a key", () => {
    const seen = new Set<string>();
    for (const group of SETTING_GROUPS) {
      assert.ok(group.title.length > 0);
      assert.ok(group.blurb.length > 0, `${group.id} has no blurb`);
      for (const spec of group.settings) {
        assert.ok(!seen.has(spec.key), `${spec.key} appears in two groups`);
        seen.add(spec.key);
      }
    }
  });
});

describe("presets", () => {
  it("only set settings that exist, to values they accept", () => {
    for (const preset of PRESETS) {
      assert.ok(preset.label.length > 0);
      assert.ok(preset.blurb.length > 0);
      for (const [key, value] of Object.entries(preset.values)) {
        const spec = findSetting(key);
        assert.ok(spec, `preset ${preset.id} sets unknown setting ${key}`);
        if (spec.type === "boolean") {
          assert.equal(typeof value, "boolean", `${preset.id}.${key}`);
        } else if (spec.type === "enum") {
          assert.ok(
            (spec.choices ?? []).some((c) => c.value === value),
            `${preset.id}.${key} = ${String(value)} is not a valid choice`
          );
        }
      }
    }
  });

  it("never touches detection or safety behind the user's back", () => {
    const offLimits = new Set(
      SETTING_GROUPS.filter((g) => g.id === "detection" || g.id === "safety")
        .flatMap((g) => g.settings)
        .map((s) => s.key)
    );
    for (const preset of PRESETS) {
      for (const key of Object.keys(preset.values)) {
        assert.ok(
          !offLimits.has(key),
          `preset ${preset.id} changes ${key}, which is not a display choice`
        );
      }
    }
  });

  it("has a preset that reproduces the shipped defaults", () => {
    const recommended = PRESETS.find((p) => p.id === "recommended");
    assert.ok(recommended, "no recommended preset");
    for (const [key, value] of Object.entries(recommended.values)) {
      assert.deepEqual(
        value,
        findSetting(key)?.default,
        `recommended.${key} does not match the shipped default`
      );
    }
  });
});
