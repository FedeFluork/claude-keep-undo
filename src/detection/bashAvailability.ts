/**
 * Whether each workspace folder can photograph a shell command, and what that
 * means for the window.
 *
 * Git is per folder, not per window. A sibling that is not a repository — the
 * folder that only holds the `.code-workspace` file — must be skipped. The
 * other folders keep detection. Treating that skip as "this window cannot
 * detect" was how a scripts folder disabled four git repos.
 */

export type BashUnavailable = "no-git" | "not-a-repository";

export interface BashFolderProbe {
  root: string;
  name: string;
  problem: BashUnavailable | undefined;
}

export type BashDetectionPlan =
  | { kind: "all-available" }
  | {
      kind: "skip-peers";
      skipped: BashFolderProbe[];
      available: BashFolderProbe[];
    }
  | { kind: "unavailable"; problem: BashUnavailable };

export function planBashDetection(
  folders: readonly BashFolderProbe[]
): BashDetectionPlan {
  if (folders.length === 0) {
    return { kind: "all-available" };
  }
  const skipped = folders.filter((folder) => folder.problem !== undefined);
  const available = folders.filter((folder) => folder.problem === undefined);
  if (available.length > 0 && skipped.length > 0) {
    return { kind: "skip-peers", skipped, available };
  }
  if (available.length > 0) {
    return { kind: "all-available" };
  }
  return {
    kind: "unavailable",
    problem: skipped.some((folder) => folder.problem === "no-git")
      ? "no-git"
      : "not-a-repository",
  };
}
