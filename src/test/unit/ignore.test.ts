import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_IGNORE_PATTERNS,
  IGNORE_FILE_TEMPLATE,
  compileIgnore,
  parseIgnoreFile,
  relativeToRoot,
} from "../../ignore";

/**
 * The matcher decides what the extension is allowed to look at, and the same
 * compiled module runs inside the Claude Code hook, where a wrong answer copies
 * a file the user asked to be left alone into the state directory.
 *
 * The table below is the gitignore documentation turned into assertions: each
 * row is a pattern, a path, and whether git would ignore it.
 */

function rules(patterns: string[], caseSensitive = true) {
  return compileIgnore([{ label: "test", patterns }], { caseSensitive });
}

interface Case {
  pattern: string;
  ignored: string[];
  kept: string[];
}

const CASES: Case[] = [
  {
    pattern: "*.log",
    ignored: ["a.log", "deep/nested/b.log", "x/.log"],
    kept: ["a.log.txt", "log", "a.logger"],
  },
  {
    pattern: "build/",
    ignored: ["build/out.js", "src/build/out.js", "a/b/build/c/d.ts"],
    // `build` itself is a file here, and a directory-only pattern must not
    // match one: that is the difference between hiding a folder and hiding a
    // source file that happens to share its name.
    kept: ["build", "builder/out.js", "rebuild/out.js"],
  },
  {
    pattern: "/build",
    ignored: ["build", "build/out.js"],
    kept: ["src/build", "src/build/out.js"],
  },
  {
    pattern: "doc/frotz/",
    ignored: ["doc/frotz/a.txt"],
    kept: ["a/doc/frotz/a.txt", "doc/frotz"],
  },
  {
    pattern: "frotz/",
    ignored: ["frotz/a.txt", "a/frotz/b.txt"],
    kept: ["frotz"],
  },
  {
    pattern: "foo/*",
    ignored: ["foo/bar", "foo/.hidden"],
    // `*` does not cross a separator, so the grandchild is only reached through
    // its parent — which the ancestor walk excludes anyway.
    kept: ["foo", "bar/foo"],
  },
  {
    pattern: "foo/**",
    ignored: ["foo/bar", "foo/bar/baz.ts"],
    kept: ["foo", "bar/foo/baz.ts"],
  },
  {
    pattern: "**/foo",
    ignored: ["foo", "a/foo", "a/b/foo"],
    kept: ["foobar", "a/foobar"],
  },
  {
    pattern: "a/**/b",
    ignored: ["a/b", "a/x/b", "a/x/y/b"],
    kept: ["b", "x/a/b"],
  },
  {
    pattern: "temp?.txt",
    ignored: ["temp1.txt", "d/tempX.txt"],
    kept: ["temp.txt", "temp12.txt", "temp/.txt"],
  },
  {
    pattern: "[abc].ts",
    ignored: ["a.ts", "b.ts", "deep/c.ts"],
    kept: ["d.ts", "ab.ts"],
  },
  {
    pattern: "[a-c]*.ts",
    ignored: ["auth.ts", "cache.ts"],
    kept: ["diff.ts"],
  },
  {
    pattern: "[!a]*.ts",
    ignored: ["b.ts", "cache.ts"],
    kept: ["auth.ts"],
  },
  {
    pattern: "\\#notes.md",
    ignored: ["#notes.md", "docs/#notes.md"],
    kept: ["notes.md"],
  },
  {
    pattern: "src/generated",
    ignored: ["src/generated", "src/generated/api.ts"],
    kept: ["generated", "lib/src/generated"],
  },
  {
    // Dots are literal, not "any character".
    pattern: ".env",
    ignored: [".env", "config/.env"],
    kept: ["xenv", "aenv/x"],
  },
];

describe("ignore: gitignore semantics", () => {
  for (const testCase of CASES) {
    it(`${testCase.pattern}`, () => {
      const matcher = rules([testCase.pattern]);
      for (const p of testCase.ignored) {
        assert.equal(
          matcher.ignoresRelative(p),
          true,
          `${testCase.pattern} should ignore ${p}`
        );
      }
      for (const p of testCase.kept) {
        assert.equal(
          matcher.ignoresRelative(p),
          false,
          `${testCase.pattern} should keep ${p}`
        );
      }
    });
  }
});

describe("ignore: negation", () => {
  it("lets a later rule re-include a file", () => {
    const matcher = rules(["*.log", "!keep.log"]);
    assert.equal(matcher.ignoresRelative("a.log"), true);
    assert.equal(matcher.ignoresRelative("keep.log"), false);
    assert.equal(matcher.ignoresRelative("deep/keep.log"), false);
  });

  it("gives the last matching rule the decision, in both directions", () => {
    assert.equal(rules(["!a.log", "*.log"]).ignoresRelative("a.log"), true);
    assert.equal(rules(["*.log", "!a.log"]).ignoresRelative("a.log"), false);
  });

  it("cannot re-include a file under an excluded directory", () => {
    // Git's own rule, and the reason the ancestors are walked first: without it
    // the exclusion of a whole tree would be quietly undone one file at a time.
    const matcher = rules(["build/", "!build/keep.txt"]);
    assert.equal(matcher.ignoresRelative("build/keep.txt"), true);
  });

  it("re-includes a subtree when the directory itself was not excluded", () => {
    const matcher = rules(["build/**", "!build/keep.txt"]);
    assert.equal(matcher.ignoresRelative("build/other.txt"), true);
    assert.equal(matcher.ignoresRelative("build/keep.txt"), false);
  });
});

describe("ignore: sources", () => {
  it("applies sources in order, so a later one can override", () => {
    const matcher = compileIgnore([
      { label: "defaults", patterns: ["*.log"] },
      { label: ".keepundoignore", patterns: ["!important.log"] },
    ]);
    assert.equal(matcher.ignoresRelative("a.log"), true);
    assert.equal(matcher.ignoresRelative("important.log"), false);
  });

  it("attributes a match to the source that decided it", () => {
    const matcher = compileIgnore([
      { label: "defaults", patterns: ["node_modules/"] },
      { label: "settings", patterns: ["dist/"] },
    ]);
    assert.equal(matcher.matchRelative("dist/app.js")?.source, "settings");
    assert.equal(
      matcher.matchRelative("node_modules/x/index.js")?.pattern,
      "node_modules/"
    );
  });

  it("ignores comments, blank lines and whitespace", () => {
    const matcher = rules(parseIgnoreFile(IGNORE_FILE_TEMPLATE));
    // Every line of the shipped template is either a comment or blank, so a
    // freshly created file must not exclude anything at all.
    assert.equal(matcher.size, 0);
    assert.equal(matcher.ignoresRelative("dist/app.js"), false);
  });

  it("strips a byte order mark from the first pattern", () => {
    // Written as an escape on purpose: a literal U+FEFF in this source file is
    // invisible, and every tool in the chain is entitled to move or drop it.
    const matcher = rules(parseIgnoreFile("\uFEFF" + "dist/"));
    assert.equal(matcher.ignoresRelative("dist/app.js"), true);
  });

  it("accepts CRLF line endings", () => {
    const matcher = rules(parseIgnoreFile("dist/\r\n*.log\r\n"));
    assert.equal(matcher.ignoresRelative("dist/app.js"), true);
    assert.equal(matcher.ignoresRelative("a.log"), true);
  });

  it("trims indentation but keeps an escaped trailing space", () => {
    assert.equal(rules(["   dist/"]).ignoresRelative("dist/a.js"), true);
    assert.equal(rules(["a.log   "]).ignoresRelative("a.log"), true);
    assert.equal(rules(["a\\ "]).ignoresRelative("a "), true);
  });

  it("has no rules, and no opinion, when every source is empty", () => {
    const matcher = compileIgnore([{ label: "settings", patterns: [] }]);
    assert.equal(matcher.isEmpty, true);
    assert.equal(matcher.ignoresRelative("anything/at/all.ts"), false);
  });
});

describe("ignore: defaults", () => {
  it("covers the two directories nobody reviews", () => {
    const matcher = rules([...DEFAULT_IGNORE_PATTERNS]);
    assert.equal(matcher.ignoresRelative(".git/HEAD"), true);
    assert.equal(
      matcher.ignoresRelative("node_modules/left-pad/index.js"),
      true
    );
    assert.equal(matcher.ignoresRelative("src/extension.ts"), false);
    // A directory *named* like one of them, nested, is still one of them.
    assert.equal(matcher.ignoresRelative("packages/a/node_modules/x.js"), true);
  });

  it("keeps a source file whose name only starts like a default", () => {
    const matcher = rules([...DEFAULT_IGNORE_PATTERNS]);
    assert.equal(matcher.ignoresRelative(".gitignore"), false);
    assert.equal(matcher.ignoresRelative("node_modules_backup/x.js"), false);
  });
});

describe("ignore: case sensitivity", () => {
  it("folds case when the platform does", () => {
    const matcher = rules(["dist/"], false);
    assert.equal(matcher.ignoresRelative("DIST/app.js"), true);
    assert.equal(matcher.ignoresRelative("Dist/App.js"), true);
  });

  it("does not fold case when the platform does not", () => {
    const matcher = rules(["dist/"], true);
    assert.equal(matcher.ignoresRelative("DIST/app.js"), false);
  });
});

describe("ignore: absolute paths", () => {
  const root = path.resolve("/workspace/project");

  it("matches a path inside the root", () => {
    const matcher = rules(["dist/"]);
    assert.equal(
      matcher.ignores(root, path.join(root, "dist", "app.js")),
      true
    );
    assert.equal(
      matcher.ignores(root, path.join(root, "src", "app.ts")),
      false
    );
  });

  it("says nothing about a path outside the root", () => {
    // Workspace scope is `ChangeStore.isInScope`'s question. Answering it here
    // as well would give one behaviour two owners that could disagree.
    const matcher = rules(["*"]);
    assert.equal(matcher.ignores(root, path.resolve("/elsewhere/a.ts")), false);
    assert.equal(matcher.ignores(root, root), false);
  });

  it("does not treat a sibling named like the root as inside it", () => {
    const matcher = rules(["*"]);
    assert.equal(
      matcher.ignores(root, path.resolve("/workspace/project-other/a.ts")),
      false
    );
  });

  it("relativeToRoot normalises separators and rejects escapes", () => {
    assert.equal(relativeToRoot(root, path.join(root, "a", "b.ts")), "a/b.ts");
    assert.equal(relativeToRoot(root, root), undefined);
    assert.equal(relativeToRoot(root, path.resolve("/workspace")), undefined);
    // A directory genuinely named `..cache` is inside the root, not above it.
    assert.equal(
      relativeToRoot(root, path.join(root, "..cache", "x")),
      "..cache/x"
    );
  });
});

describe("ignore: directories", () => {
  it("distinguishes a directory from a file with the same name", () => {
    const matcher = rules(["out/"]);
    assert.equal(matcher.ignoresRelative("out", true), true);
    assert.equal(matcher.ignoresRelative("out", false), false);
  });

  it("matches a plain pattern against both", () => {
    const matcher = rules(["out"]);
    assert.equal(matcher.ignoresRelative("out", true), true);
    assert.equal(matcher.ignoresRelative("out", false), true);
  });

  it("carries the flag through the absolute-path form", () => {
    // What the "stop reviewing this" command asks: a folder already covered by
    // `build/` must be recognised as covered rather than given a second rule.
    const root = path.resolve("/workspace/project");
    const matcher = rules(["build/"]);
    const folder = path.join(root, "build");
    assert.equal(matcher.ignores(root, folder, true), true);
    assert.equal(matcher.ignores(root, folder), false);
    assert.equal(matcher.match(root, folder, true)?.pattern, "build/");
  });
});
