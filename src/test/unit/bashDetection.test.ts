import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planBashDetection } from "../../detection/bashAvailability";

describe("planBashDetection", () => {
  const repo = (name: string) => ({
    root: `/ws/${name}`,
    name,
    problem: undefined,
  });
  const scripts = {
    root: "/ws/workspace",
    name: "workspace",
    problem: "not-a-repository" as const,
  };

  it("treats an empty window as available", () => {
    assert.deepEqual(planBashDetection([]), { kind: "all-available" });
  });

  it("does not warn when every folder is a repository", () => {
    assert.deepEqual(planBashDetection([repo("a"), repo("b")]), {
      kind: "all-available",
    });
  });

  it("skips a non-git sibling and keeps the git repos", () => {
    // The work layout that started this: four git repos plus a folder that
    // only holds the .code-workspace file and a package.json.
    const folders = [scripts, repo("a"), repo("b"), repo("c"), repo("d")];
    const plan = planBashDetection(folders);
    assert.equal(plan.kind, "skip-peers");
    if (plan.kind !== "skip-peers") {
      return;
    }
    assert.deepEqual(
      plan.skipped.map((f) => f.name),
      ["workspace"]
    );
    assert.deepEqual(
      plan.available.map((f) => f.name),
      ["a", "b", "c", "d"]
    );
  });

  it("is unavailable only when no folder can run git", () => {
    assert.deepEqual(planBashDetection([scripts]), {
      kind: "unavailable",
      problem: "not-a-repository",
    });
    assert.deepEqual(
      planBashDetection([
        { root: "/a", name: "a", problem: "no-git" },
        { root: "/b", name: "b", problem: "no-git" },
      ]),
      { kind: "unavailable", problem: "no-git" }
    );
  });

  it("prefers the PATH failure when every folder failed", () => {
    assert.deepEqual(
      planBashDetection([
        { root: "/a", name: "a", problem: "no-git" },
        scripts,
      ]),
      { kind: "unavailable", problem: "no-git" }
    );
  });
});
