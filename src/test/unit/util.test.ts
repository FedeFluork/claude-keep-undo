import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  atomicCopy,
  atomicWrite,
  CURRENT_SCHEME,
  descendantFolderStores,
  encodeProjectDir,
  HOOK_PEERS_TTL_MS,
  isInsideRoot,
  isUtf8Text,
  listDir,
  existingStatePairs,
  locateStatePair,
  ownStatePair,
  looksBinary,
  owningPeer,
  owningRoot,
  otherWindowHoldsFolder,
  parseHookPeers,
  PathMap,
  PathSet,
  pathIsInFolderScope,
  pathKey,
  normalizePath,
  readFileBytesResult,
  readFileResult,
  readHookPeerRegistrations,
  readSidecar,
  relatedFolderStores,
  rehomeDisplacedPairs,
  relocateStatePair,
  removeStatePairs,
  serializeHookPeerRegistration,
  serializeHookPeers,
  sidecarPath,
  uniqueSuffix,
  unionHookPeers,
  writeFolderIdentity,
} from "../../util";

let tmp: string;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keepundo-test-"));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("readFileResult", () => {
  it("distinguishes missing from empty", () => {
    const empty = path.join(tmp, "empty.txt");
    fs.writeFileSync(empty, "");
    assert.deepEqual(readFileResult(empty), { kind: "ok", text: "" });
    assert.deepEqual(readFileResult(path.join(tmp, "nope.txt")), {
      kind: "missing",
    });
  });

  it("reports a directory as an error, not as an empty file", () => {
    // Treating this as "" would make the extension believe Claude deleted the
    // whole file and offer an Undo that recreates it.
    const result = readFileResult(tmp);
    assert.equal(result.kind, "error");
  });
});

describe("readFileBytesResult", () => {
  it("rejects a windows-1252 source that looksBinary lets through", () => {
    // The silent half of the corruption. `looksBinary` needs more than one bad
    // byte per two hundred characters, so a mostly-ASCII file with three accented
    // characters passes it, gets tracked, and its baseline is stored with U+FFFD
    // where those bytes were. Undo then writes `Jos�` over `José`.
    const file = path.join(tmp, "legacy-latin1.java");
    const bytes = Buffer.from(
      "// author: Jos\xe9 Mu\xf1oz, r\xe9vision\n" +
        "const x = 1;\n".repeat(400),
      "latin1"
    );
    fs.writeFileSync(file, bytes);

    assert.equal(
      looksBinary(fs.readFileSync(file, "utf8")),
      false,
      "the heuristic is exactly what misses this case"
    );
    assert.equal(readFileBytesResult(file).kind, "binary");
  });

  it("rejects non-UTF-8 bytes past the heuristic's 8 KiB sample", () => {
    const file = path.join(tmp, "late-bytes.min.js");
    fs.writeFileSync(
      file,
      Buffer.concat([Buffer.from("a".repeat(9000)), Buffer.from([0xff, 0xfe])])
    );
    assert.equal(looksBinary(fs.readFileSync(file, "utf8")), false);
    assert.equal(readFileBytesResult(file).kind, "binary");
  });

  it("accepts real UTF-8, accents and all, with its byte length", () => {
    const file = path.join(tmp, "utf8.ts");
    fs.writeFileSync(file, "// José Muñoz\nconst x = 1;\n", "utf8");
    const result = readFileBytesResult(file);
    assert.equal(result.kind, "ok");
    assert.equal(
      result.kind === "ok" && result.bytes,
      fs.statSync(file).size,
      "the byte count is what a baseline is later checked against"
    );
  });

  it("keeps missing and unreadable apart from empty", () => {
    const empty = path.join(tmp, "empty-bytes.txt");
    fs.writeFileSync(empty, "");
    assert.deepEqual(readFileBytesResult(empty), {
      kind: "ok",
      text: "",
      bytes: 0,
    });
    assert.equal(
      readFileBytesResult(path.join(tmp, "absent.txt")).kind,
      "missing"
    );
    assert.equal(readFileBytesResult(tmp).kind, "error");
  });

  it("rejects NUL bytes even though they are valid UTF-8", () => {
    assert.equal(isUtf8Text(Buffer.from([0x61, 0x00, 0x62])), false);
    assert.equal(isUtf8Text(Buffer.from("plain text", "utf8")), true);
  });
});

describe("atomicCopy", () => {
  it("copies bytes verbatim, including bytes that are not UTF-8", () => {
    // A recovery snapshot has to be byte-exact to be a recovery: decoding and
    // re-encoding would store U+FFFD in place of every bad byte, so the copy taken
    // to protect the file would itself be the corrupted version.
    const from = path.join(tmp, "binary-source.bin");
    const to = path.join(tmp, "snapshots", "binary-copy");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x41]);
    fs.writeFileSync(from, bytes);

    assert.equal(atomicCopy(from, to), "copied");
    assert.equal(Buffer.compare(fs.readFileSync(to), bytes), 0);
  });

  it("reports a missing source rather than throwing", () => {
    assert.equal(
      atomicCopy(path.join(tmp, "no-such-file"), path.join(tmp, "dest")),
      "missing"
    );
  });

  it("leaves no temporary file behind when the copy fails", () => {
    const dir = path.join(tmp, "copyclean");
    fs.mkdirSync(dir, { recursive: true });
    const blocker = path.join(dir, "blocker.txt");
    fs.writeFileSync(blocker, "x");
    atomicCopy(blocker, path.join(blocker, "child"));
    assert.deepEqual(
      listDir(dir).filter((f) => f.endsWith(".tmp")),
      []
    );
  });
});

describe("atomicWrite", () => {
  it("creates missing parent directories", () => {
    const target = path.join(tmp, "deep", "nested", "file.txt");
    assert.equal(atomicWrite(target, "hello"), true);
    assert.equal(fs.readFileSync(target, "utf8"), "hello");
  });

  it("overwrites an existing file", () => {
    const target = path.join(tmp, "twice.txt");
    atomicWrite(target, "one");
    atomicWrite(target, "two");
    assert.equal(fs.readFileSync(target, "utf8"), "two");
  });

  it("returns false instead of throwing when the path is impossible", () => {
    const blocker = path.join(tmp, "blocker.txt");
    fs.writeFileSync(blocker, "x");
    // `blocker` is a file, so it cannot also be a directory.
    assert.equal(atomicWrite(path.join(blocker, "child.txt"), "nope"), false);
  });

  it("leaves no temporary files behind on failure", () => {
    const dir = path.join(tmp, "clean");
    fs.mkdirSync(dir, { recursive: true });
    const blocker = path.join(dir, "blocker.txt");
    fs.writeFileSync(blocker, "x");
    atomicWrite(path.join(blocker, "child.txt"), "nope");
    assert.deepEqual(
      listDir(dir).filter((f) => f.endsWith(".tmp")),
      []
    );
  });
});

describe("uniqueSuffix", () => {
  it("never repeats within the same millisecond", () => {
    // `Date.now()` alone collides, which silently overwrites the recovery
    // snapshot taken a moment earlier and lets two temp files fight.
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      seen.add(uniqueSuffix());
    }
    assert.equal(seen.size, 5000);
  });
});

describe("sidecars", () => {
  it("round-trips a baseline descriptor", () => {
    const content = path.join(tmp, "baselines", "abc123");
    atomicWrite(content, "original");
    atomicWrite(
      sidecarPath(content),
      JSON.stringify({ path: "/some/file.ts", ts: 42 })
    );
    assert.deepEqual(readSidecar(content), {
      path: "/some/file.ts",
      ts: 42,
      created: false,
    });
  });

  it("carries the flag that says Claude created the file", () => {
    // Without it an empty baseline is indistinguishable from "the file existed
    // and was empty", and Undo writes an empty file instead of removing it.
    const content = path.join(tmp, "baselines", "created1");
    atomicWrite(content, "");
    atomicWrite(
      sidecarPath(content),
      JSON.stringify({ path: "/some/new.ts", ts: 7, created: true })
    );
    assert.deepEqual(readSidecar(content), {
      path: "/some/new.ts",
      ts: 7,
      created: true,
    });
  });

  it("defaults the flag to false for a sidecar written before 1.1.0", () => {
    const content = path.join(tmp, "baselines", "legacy1");
    atomicWrite(content, "x");
    atomicWrite(
      sidecarPath(content),
      JSON.stringify({ path: "/some/old.ts", ts: 1 })
    );
    assert.equal(readSidecar(content)?.created, false);
  });

  it("carries the captured byte length, and omits it when unrecorded", () => {
    // The extension re-measures a stored baseline against this number and refuses
    // to track the file when the two disagree, so a lossily decoded copy can never
    // reach an Undo. A pre-1.1.1 sidecar has no number, which has to stay
    // distinguishable from zero.
    const withBytes = path.join(tmp, "baselines", "bytes1");
    atomicWrite(withBytes, "hé\n");
    atomicWrite(
      sidecarPath(withBytes),
      JSON.stringify({ path: "/some/a.ts", ts: 1, bytes: 4 })
    );
    assert.equal(readSidecar(withBytes)?.bytes, 4);

    const legacy = path.join(tmp, "baselines", "bytes2");
    atomicWrite(legacy, "x");
    atomicWrite(
      sidecarPath(legacy),
      JSON.stringify({ path: "/some/b.ts", ts: 1 })
    );
    assert.equal("bytes" in (readSidecar(legacy) ?? {}), false);
  });

  it("returns undefined for a missing or malformed sidecar", () => {
    const content = path.join(tmp, "baselines", "def456");
    atomicWrite(content, "original");
    assert.equal(readSidecar(content), undefined);
    atomicWrite(sidecarPath(content), "{ not json");
    assert.equal(readSidecar(content), undefined);
    atomicWrite(sidecarPath(content), JSON.stringify({ ts: 1 }));
    assert.equal(readSidecar(content), undefined);
  });
});

describe("path helpers", () => {
  it("names the virtual document used when a reviewed file is gone", () => {
    assert.equal(CURRENT_SCHEME, "claude-current");
  });

  it("hashes paths to a short stable key", () => {
    const key = pathKey("/a/b/c.ts");
    assert.equal(key.length, 16);
    assert.equal(key, pathKey("/a/b/c.ts"));
    assert.notEqual(key, pathKey("/a/b/d.ts"));
  });

  it("encodes a project directory the way Claude Code does", () => {
    assert.equal(
      encodeProjectDir("/Users/x/Documents/claude_keepundo"),
      "-Users-x-Documents-claude-keepundo"
    );
  });
});

describe("PathMap / PathSet", () => {
  it("treats two spellings of the same file as one entry", () => {
    const file = path.join(tmp, "SHELL_TEST_V2.txt");
    const alt = flipPathCase(file);
    if (alt === file || normalizePath(file) !== normalizePath(alt)) {
      return; // Linux does not fold, so these would be two files
    }
    const map = new PathMap<string>();
    map.set(file, "from-hook");
    assert.equal(map.get(alt), "from-hook");
    assert.equal(map.has(alt), true);
    map.delete(alt);
    assert.equal(map.has(file), false);

    const set = new PathSet();
    set.add(file);
    assert.equal(set.has(alt), true);
    set.delete(alt);
    assert.equal(set.has(file), false);
  });
});

describe("isInsideRoot", () => {
  const root = path.join(tmp, "proj");

  it("accepts a file or subdirectory of the root", () => {
    assert.equal(isInsideRoot(root, path.join(root, "src", "a.ts")), true);
    assert.equal(isInsideRoot(root, path.join(root, "src")), true);
  });

  it("rejects the root itself", () => {
    assert.equal(isInsideRoot(root, root), false);
  });

  it("rejects a sibling that only shares a prefix", () => {
    assert.equal(
      isInsideRoot(root, path.join(tmp, "proj-other", "a.ts")),
      false
    );
    assert.equal(
      isInsideRoot(path.join(tmp, "app"), path.join(tmp, "apple", "x.ts")),
      false
    );
  });
});

describe("owningRoot", () => {
  it("picks the deepest nested root", () => {
    const outer = path.join(tmp, "outer");
    const inner = path.join(outer, "inner");
    const nested = path.join(inner, "a.ts");
    assert.equal(owningRoot([outer, inner], nested), inner);
    assert.equal(owningRoot([outer], nested), outer);
  });

  it("returns undefined when no root contains the file", () => {
    const a = path.join(tmp, "a");
    const b = path.join(tmp, "b", "file.ts");
    assert.equal(owningRoot([a], b), undefined);
  });
});

describe("pathIsInFolderScope", () => {
  it("does not treat a sibling workspace folder as outside-the-workspace", () => {
    const a = path.join(tmp, "repo-a");
    const b = path.join(tmp, "repo-b");
    const fileB = path.join(b, "src", "x.ts");
    assert.equal(pathIsInFolderScope(fileB, a, [b], true), false);
    assert.equal(pathIsInFolderScope(fileB, b, [a], false), true);
  });

  it("gives nested files to the inner root", () => {
    const outer = path.join(tmp, "mono");
    const inner = path.join(outer, "pkg");
    const file = path.join(inner, "index.ts");
    assert.equal(pathIsInFolderScope(file, inner, [outer], false), true);
    assert.equal(pathIsInFolderScope(file, outer, [inner], false), false);
  });

  it("honours trackOutside for paths under no folder", () => {
    const a = path.join(tmp, "only");
    const outside = path.join(tmp, "elsewhere", "scratch.ts");
    assert.equal(pathIsInFolderScope(outside, a, [], true), true);
    assert.equal(pathIsInFolderScope(outside, a, [], false), false);
  });
});

describe("hook peers", () => {
  it("falls back to the session folder when the file is missing", () => {
    const self = { root: "/ws/a", stateDir: "/state/a" };
    assert.deepEqual(parseHookPeers(undefined, self), [self]);
    assert.deepEqual(parseHookPeers("{", self), [self]);
  });

  it("reads every well-formed folder and skips junk", () => {
    const a = { root: "/ws/a", stateDir: "/state/a" };
    const b = { root: "/ws/b", stateDir: "/state/b" };
    const raw = serializeHookPeers([a, b]);
    assert.deepEqual(parseHookPeers(raw, a), [a, b]);
    const mixed = JSON.stringify({
      v: 1,
      folders: [a, { root: 1 }, b, null],
    });
    assert.deepEqual(parseHookPeers(mixed, a), [a, b]);
  });

  it("keeps bash:false on a non-git sibling and ignores bash:true", () => {
    const scripts = {
      root: "/ws/workspace",
      stateDir: "/state/workspace",
      bash: false as const,
    };
    const repo = { root: "/ws/repo-a", stateDir: "/state/a" };
    assert.deepEqual(
      parseHookPeers(serializeHookPeers([scripts, repo]), repo),
      [scripts, repo]
    );
    const withTrue = JSON.stringify({
      v: 1,
      folders: [{ ...repo, bash: true }, scripts],
    });
    assert.deepEqual(parseHookPeers(withTrue, repo), [repo, scripts]);
  });

  it("unions two windows instead of letting the last one win", () => {
    const a = { root: path.join(tmp, "repo-a"), stateDir: "/state/a" };
    const b = { root: path.join(tmp, "repo-b"), stateDir: "/state/b" };
    assert.deepEqual(unionHookPeers([[a, b], [a]], a), [a, b]);
  });

  it("combines per-window registrations on disk", () => {
    const a = {
      root: path.join(tmp, "peer-a"),
      stateDir: path.join(tmp, "state-a"),
    };
    const b = {
      root: path.join(tmp, "peer-b"),
      stateDir: path.join(tmp, "state-b"),
    };
    const stateDir = path.join(tmp, "peer-reg");
    atomicWrite(
      path.join(stateDir, "peers.d", "window-ab.json"),
      serializeHookPeers([a, b])
    );
    atomicWrite(
      path.join(stateDir, "peers.d", "window-a.json"),
      serializeHookPeers([a])
    );
    const combined = readHookPeerRegistrations(stateDir, a);
    const roots = combined.map((f) => f.root).sort();
    assert.deepEqual(roots, [a.root, b.root].sort());
  });

  it("does not restore the last union after every window file is gone", () => {
    const a = {
      root: path.join(tmp, "empty-a"),
      stateDir: path.join(tmp, "empty-state-a"),
    };
    const b = {
      root: path.join(tmp, "empty-b"),
      stateDir: path.join(tmp, "empty-state-b"),
    };
    const stateDir = path.join(tmp, "peer-empty");
    atomicWrite(path.join(stateDir, "peers.json"), serializeHookPeers([a, b]));
    fs.mkdirSync(path.join(stateDir, "peers.d"), { recursive: true });
    assert.deepEqual(readHookPeerRegistrations(stateDir, a), [a]);
  });

  it("drops an expired window registration", () => {
    const a = {
      root: path.join(tmp, "exp-a"),
      stateDir: path.join(tmp, "exp-state-a"),
    };
    const b = {
      root: path.join(tmp, "exp-b"),
      stateDir: path.join(tmp, "exp-state-b"),
    };
    const stateDir = path.join(tmp, "peer-expired");
    const stale = path.join(stateDir, "peers.d", "stale.json");
    atomicWrite(
      stale,
      serializeHookPeerRegistration(
        [a, b],
        Date.now() - HOOK_PEERS_TTL_MS - 1000
      )
    );
    assert.deepEqual(readHookPeerRegistrations(stateDir, a), [a]);
    assert.equal(fs.existsSync(stale), false);
  });

  it("gives a sibling path to that sibling's folder", () => {
    const a = { root: path.join(tmp, "repo-a"), stateDir: "/state/a" };
    const b = { root: path.join(tmp, "repo-b"), stateDir: "/state/b" };
    const fileB = path.join(b.root, "CROSS.txt");
    assert.equal(owningPeer([a, b], fileB), b);
    assert.equal(owningPeer([a, b], path.join(a.root, "x.ts")), a);
    assert.equal(
      owningPeer([a, b], path.join(tmp, "elsewhere", "x.ts")),
      undefined
    );
  });
});

describe("relocateStatePair", () => {
  it("moves content and sidecar into the destination directory", () => {
    const srcDir = path.join(tmp, "relocate-src");
    const destDir = path.join(tmp, "relocate-dest");
    const content = path.join(srcDir, "abcd1234");
    atomicWrite(content, "original\n");
    atomicWrite(sidecarPath(content), JSON.stringify({ path: "/x.ts", ts: 1 }));
    assert.equal(relocateStatePair(content, destDir), "moved");
    const dest = path.join(destDir, "abcd1234");
    assert.equal(fs.readFileSync(dest, "utf8"), "original\n");
    assert.equal(readSidecar(dest)?.path, "/x.ts");
    assert.equal(fs.existsSync(content), false);
    assert.equal(fs.existsSync(sidecarPath(content)), false);
  });

  it("keeps the destination copy when the same key is already there", () => {
    const srcDir = path.join(tmp, "relocate-dup-src");
    const destDir = path.join(tmp, "relocate-dup-dest");
    const content = path.join(srcDir, "dupkey");
    const dest = path.join(destDir, "dupkey");
    atomicWrite(content, "source\n");
    atomicWrite(sidecarPath(content), JSON.stringify({ path: "/y.ts", ts: 1 }));
    atomicWrite(dest, "destination\n");
    atomicWrite(sidecarPath(dest), JSON.stringify({ path: "/y.ts", ts: 2 }));
    assert.equal(relocateStatePair(content, destDir), "kept-destination");
    assert.equal(fs.readFileSync(dest, "utf8"), "destination\n");
    assert.equal(fs.existsSync(content), false);
  });

  it("does not delete the file when it is already in the destination", () => {
    const dir = path.join(tmp, "relocate-same");
    const content = path.join(dir, "samekey");
    atomicWrite(content, "only-copy\n");
    atomicWrite(sidecarPath(content), JSON.stringify({ path: "/z.ts", ts: 1 }));
    assert.equal(relocateStatePair(content, dir), "moved");
    assert.equal(fs.readFileSync(content, "utf8"), "only-copy\n");
  });
});

describe("rehomeDisplacedPairs", () => {
  it("moves a nested file into the inner folder and leaves a foreign one", () => {
    const outer = path.join(tmp, "mono");
    const inner = path.join(outer, "pkg");
    const nested = path.join(inner, "index.ts");
    const foreign = path.join(tmp, "elsewhere", "scratch.ts");
    const outerState = path.join(tmp, "state-outer");
    const innerState = path.join(tmp, "state-inner");
    const nestedKey = pathKey(nested);
    const foreignKey = pathKey(foreign);
    const nestedContent = path.join(outerState, "baselines", nestedKey);
    const foreignContent = path.join(outerState, "baselines", foreignKey);
    atomicWrite(nestedContent, "nested-orig\n");
    atomicWrite(
      sidecarPath(nestedContent),
      JSON.stringify({ path: nested, ts: 1 })
    );
    atomicWrite(foreignContent, "foreign-orig\n");
    atomicWrite(
      sidecarPath(foreignContent),
      JSON.stringify({ path: foreign, ts: 1 })
    );

    const n = rehomeDisplacedPairs(
      outerState,
      outer,
      [
        { root: outer, stateDir: outerState },
        { root: inner, stateDir: innerState },
      ],
      "baselines"
    );
    assert.equal(n, 1);
    const dest = path.join(innerState, "baselines", nestedKey);
    assert.equal(fs.readFileSync(dest, "utf8"), "nested-orig\n");
    assert.equal(fs.existsSync(nestedContent), false);
    assert.equal(
      fs.readFileSync(foreignContent, "utf8"),
      "foreign-orig\n",
      "a path no peer owns must stay put"
    );
  });

  it("moves a nested file back to the outer folder when the inner leaves", () => {
    const outer = path.join(tmp, "mono-back");
    const inner = path.join(outer, "pkg");
    const nested = path.join(inner, "lib.ts");
    const innerState = path.join(tmp, "state-inner-back");
    const outerState = path.join(tmp, "state-outer-back");
    const key = pathKey(nested);
    const content = path.join(innerState, "baselines", key);
    atomicWrite(content, "from-inner\n");
    atomicWrite(sidecarPath(content), JSON.stringify({ path: nested, ts: 1 }));

    const n = rehomeDisplacedPairs(
      innerState,
      inner,
      [{ root: outer, stateDir: outerState }],
      "baselines"
    );
    assert.equal(n, 1);
    assert.equal(
      fs.readFileSync(path.join(outerState, "baselines", key), "utf8"),
      "from-inner\n"
    );
    assert.equal(fs.existsSync(content), false);
  });

  it("keeps a nested file in the inner store when that folder is still open", () => {
    const outer = path.join(tmp, "mono-stay");
    const inner = path.join(outer, "pkg");
    const nested = path.join(inner, "keep.ts");
    const innerState = path.join(tmp, "state-inner-stay");
    const outerState = path.join(tmp, "state-outer-stay");
    const key = pathKey(nested);
    const content = path.join(innerState, "baselines", key);
    atomicWrite(content, "stay-inner\n");
    atomicWrite(sidecarPath(content), JSON.stringify({ path: nested, ts: 1 }));

    const n = rehomeDisplacedPairs(
      innerState,
      inner,
      [
        { root: inner, stateDir: innerState },
        { root: outer, stateDir: outerState },
      ],
      "baselines"
    );
    assert.equal(n, 0);
    assert.equal(fs.readFileSync(content, "utf8"), "stay-inner\n");
    assert.equal(
      fs.existsSync(path.join(outerState, "baselines", key)),
      false,
      "the outer store must not take a file the inner folder itself owns"
    );
  });

  it("leaves nested files in the outer store when another window lacks the inner folder", () => {
    const outer = path.join(tmp, "mono-hold");
    const inner = path.join(outer, "pkg");
    const nested = path.join(inner, "held.ts");
    const outerState = path.join(tmp, "state-outer-hold");
    const innerState = path.join(tmp, "state-inner-hold");
    const key = pathKey(nested);
    const content = path.join(outerState, "baselines", key);
    atomicWrite(content, "keep-outer\n");
    atomicWrite(sidecarPath(content), JSON.stringify({ path: nested, ts: 1 }));
    atomicWrite(
      path.join(outerState, "peers.d", "outer-only.json"),
      serializeHookPeerRegistration([{ root: outer, stateDir: outerState }])
    );
    atomicWrite(
      path.join(outerState, "peers.d", "nested.json"),
      serializeHookPeerRegistration([
        { root: outer, stateDir: outerState },
        { root: inner, stateDir: innerState },
      ])
    );

    const n = rehomeDisplacedPairs(
      outerState,
      outer,
      [
        { root: outer, stateDir: outerState },
        { root: inner, stateDir: innerState },
      ],
      "baselines"
    );
    assert.equal(n, 0);
    assert.equal(fs.readFileSync(content, "utf8"), "keep-outer\n");
    assert.equal(otherWindowHoldsFolder(outerState, outer, inner), true);
  });
});

describe("locateStatePair", () => {
  it("prefers this window's copy and does not delete the other store", () => {
    const outer = path.join(tmp, "mono-dup");
    const inner = path.join(outer, "pkg");
    const nested = path.join(inner, "dup.ts");
    const outerState = path.join(tmp, "state-outer-dup");
    const innerState = path.join(tmp, "state-inner-dup");
    const key = pathKey(nested);
    const outerContent = path.join(outerState, "baselines", key);
    const innerContent = path.join(innerState, "baselines", key);
    atomicWrite(outerContent, "outer-original\n");
    atomicWrite(
      sidecarPath(outerContent),
      JSON.stringify({ path: nested, ts: 1 })
    );
    atomicWrite(innerContent, "inner-copy\n");
    atomicWrite(
      sidecarPath(innerContent),
      JSON.stringify({ path: nested, ts: 2 })
    );
    const stores = [
      { root: outer, stateDir: outerState },
      { root: inner, stateDir: innerState },
    ];
    assert.equal(
      locateStatePair(nested, stores, "baselines", outerState),
      outerContent
    );
    assert.equal(
      locateStatePair(nested, stores, "baselines", innerState),
      innerContent
    );
    assert.equal(fs.readFileSync(outerContent, "utf8"), "outer-original\n");
    assert.equal(fs.readFileSync(innerContent, "utf8"), "inner-copy\n");
  });

  it("falls back to a related store when this window has no copy", () => {
    const outer = path.join(tmp, "mono-fb");
    const inner = path.join(outer, "pkg");
    const nested = path.join(inner, "fb.ts");
    const outerState = path.join(tmp, "state-outer-fb");
    const innerState = path.join(tmp, "state-inner-fb");
    const innerContent = path.join(innerState, "baselines", pathKey(nested));
    atomicWrite(innerContent, "only-inner\n");
    atomicWrite(
      sidecarPath(innerContent),
      JSON.stringify({ path: nested, ts: 1 })
    );
    const winner = locateStatePair(
      nested,
      [
        { root: outer, stateDir: outerState },
        { root: inner, stateDir: innerState },
      ],
      "baselines",
      outerState
    );
    assert.equal(winner, innerContent);
    assert.equal(fs.readFileSync(innerContent, "utf8"), "only-inner\n");
  });

  it("falls back to a parent store when the nested window has no copy", () => {
    const outer = path.join(tmp, "mono-parent");
    const inner = path.join(outer, "pkg");
    const nested = path.join(inner, "from-parent.ts");
    const outerState = path.join(tmp, "state-outer-parent");
    const innerState = path.join(tmp, "state-inner-parent");
    const outerContent = path.join(outerState, "baselines", pathKey(nested));
    atomicWrite(outerContent, "only-outer\n");
    atomicWrite(
      sidecarPath(outerContent),
      JSON.stringify({ path: nested, ts: 1 })
    );
    const winner = locateStatePair(
      nested,
      [
        { root: outer, stateDir: outerState },
        { root: inner, stateDir: innerState },
      ],
      "baselines",
      innerState
    );
    assert.equal(winner, outerContent);
    assert.equal(fs.readFileSync(outerContent, "utf8"), "only-outer\n");
  });

  it("keeps new writes in this window's store", () => {
    const outer = path.join(tmp, "mono-new");
    const inner = path.join(outer, "pkg");
    const nested = path.join(inner, "new.ts");
    const outerState = path.join(tmp, "state-outer-new");
    const innerState = path.join(tmp, "state-inner-new");
    const winner = locateStatePair(
      nested,
      [
        { root: outer, stateDir: outerState },
        { root: inner, stateDir: innerState },
      ],
      "baselines",
      outerState
    );
    assert.equal(winner, path.join(outerState, "baselines", pathKey(nested)));
  });

  it("does not write into a related store that already has a copy", () => {
    const outer = path.join(tmp, "mono-own");
    const inner = path.join(outer, "pkg");
    const nested = path.join(inner, "own.ts");
    const outerState = path.join(tmp, "state-outer-own");
    const innerState = path.join(tmp, "state-inner-own");
    const innerContent = path.join(innerState, "baselines", pathKey(nested));
    atomicWrite(innerContent, "related-copy\n");
    atomicWrite(
      sidecarPath(innerContent),
      JSON.stringify({ path: nested, ts: 1 })
    );
    assert.equal(
      ownStatePair(nested, outerState, "baselines"),
      path.join(outerState, "baselines", pathKey(nested))
    );
    assert.equal(fs.readFileSync(innerContent, "utf8"), "related-copy\n");
  });
});

describe("removeStatePairs", () => {
  it("deletes every related copy so Keep cannot rediscover the original", () => {
    const outer = path.join(tmp, "mono-rm");
    const inner = path.join(outer, "pkg");
    const nested = path.join(inner, "kept.ts");
    const outerState = path.join(tmp, "state-outer-rm");
    const innerState = path.join(tmp, "state-inner-rm");
    const key = pathKey(nested);
    const outerContent = path.join(outerState, "baselines", key);
    const innerContent = path.join(innerState, "baselines", key);
    atomicWrite(outerContent, "outer-original\n");
    atomicWrite(
      sidecarPath(outerContent),
      JSON.stringify({ path: nested, ts: 1 })
    );
    atomicWrite(innerContent, "inner-copy\n");
    atomicWrite(
      sidecarPath(innerContent),
      JSON.stringify({ path: nested, ts: 2 })
    );
    const stores = [
      { root: outer, stateDir: outerState },
      { root: inner, stateDir: innerState },
    ];
    assert.deepEqual(
      existingStatePairs(nested, stores, "baselines").sort(),
      [innerContent, outerContent].sort()
    );
    assert.equal(removeStatePairs(nested, stores, "baselines"), 2);
    assert.equal(fs.existsSync(outerContent), false);
    assert.equal(fs.existsSync(innerContent), false);
    assert.equal(existingStatePairs(nested, stores, "baselines").length, 0);
  });
});

describe("descendantFolderStores", () => {
  it("finds a nested folder's state directory next to this one", () => {
    const outer = path.join(tmp, "disc-mono");
    const inner = path.join(outer, "pkg");
    const parent = path.join(tmp, "disc-folders");
    const outerState = path.join(parent, "outer");
    const innerState = path.join(parent, "inner");
    writeFolderIdentity(innerState, inner);
    writeFolderIdentity(outerState, outer);
    const found = descendantFolderStores(outerState, outer);
    assert.equal(found.length, 1);
    assert.equal(found[0].root, inner);
    assert.equal(found[0].stateDir, innerState);
    const parents = relatedFolderStores(innerState, inner);
    assert.equal(parents.length, 1);
    assert.equal(parents[0].root, outer);
    assert.equal(parents[0].stateDir, outerState);
  });
});

describe("listDir", () => {
  it("returns an empty array for a missing directory", () => {
    assert.deepEqual(listDir(path.join(tmp, "does-not-exist")), []);
  });
});

/** Flip the first letter that has case, so `D:\...` and `d:\...` can be compared. */
function flipPathCase(filePath: string): string {
  const i = [...filePath].findIndex((c) => c.toLowerCase() !== c.toUpperCase());
  if (i < 0) {
    return filePath;
  }
  const c = filePath[i];
  const flipped = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
  return filePath.slice(0, i) + flipped + filePath.slice(i + 1);
}
