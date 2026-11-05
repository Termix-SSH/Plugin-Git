import { describe, expect, it } from "vitest";
import {
  hideCredentials,
  parseAutoResult,
  parseBranches,
  parseInfo,
  parseLog,
  parseRemotes,
  parseStashes,
  parseStatus,
} from "../../src/backend/parse.js";

const STATUS = [
  "# branch.oid 1234",
  "# branch.head main",
  "# branch.upstream origin/main",
  "# branch.ab +2 -3",
  "1 .M N... 100644 100644 100644 aaa bbb src/a.ts",
  "1 A. N... 000000 100644 100644 000 ccc new file.ts",
  "2 R. N... 100644 100644 100644 aaa bbb R100 moved.ts\told.ts",
  "u UU N... 100644 100644 100644 100644 a b c conflict.ts",
  "? notes.txt",
].join("\n");

describe("status", () => {
  it("reads the branch line and the files", () => {
    const s = parseStatus(STATUS, false);
    expect(s).toMatchObject({
      branch: "main",
      upstream: "origin/main",
      ahead: 2,
      behind: 3,
      changed: 4,
      untracked: 1,
      conflicts: 1,
      detached: false,
    });
    expect(s.files.find((f) => f.path === "new file.ts")).toMatchObject({
      index: "A",
      tree: ".",
    });
    expect(s.files.find((f) => f.path === "moved.ts")?.from).toBe("old.ts");
  });

  it("reads the NUL separated form with renames", () => {
    const text = [
      "# branch.head (detached)",
      "2 R. N... 100644 100644 100644 aaa bbb R100 new.ts",
      "old.ts",
      "? x y.txt",
    ].join("\0");
    const s = parseStatus(text, true);
    expect(s.detached).toBe(true);
    expect(s.branch).toBe("");
    expect(s.files[0]).toMatchObject({ path: "new.ts", from: "old.ts" });
    expect(s.files[1].path).toBe("x y.txt");
  });
});

describe("info", () => {
  it("splits repos and flags missing ones", () => {
    const out = [
      "@@GIT@@repo",
      "/srv/app",
      "@@GIT@@status",
      "# branch.head main",
      "# branch.ab +0 -1",
      "@@GIT@@last",
      "abc\x1fAnn\x1f2026-01-01T00:00:00+00:00\x1fFix it",
      "@@GIT@@remote",
      "https://user:secret@example.com/o/r.git",
      "@@GIT@@stash",
      "2",
      "@@GIT@@repo",
      "/gone",
      "@@GIT@@missing",
      "",
    ].join("\n");
    const [a, b] = parseInfo(out);
    expect(a.name).toBe("app");
    expect(a.status?.behind).toBe(1);
    expect(a.last?.subject).toBe("Fix it");
    expect(a.remoteUrl).toBe("https://example.com/o/r.git");
    expect(a.stashes).toBe(2);
    expect(b.error).toBe("missing");
  });

  it("hides passwords in addresses", () => {
    expect(hideCredentials("https://tok@github.com/a/b")).toBe(
      "https://github.com/a/b",
    );
    expect(hideCredentials("git@github.com:a/b")).toBe("git@github.com:a/b");
  });
});

describe("lists", () => {
  it("reads the log", () => {
    const text =
      "h1\x1fh1s\x1fAnn\x1f2026-01-01\x1fHEAD -> main, origin/main\x1fOne\x1e\nh2\x1fh2s\x1fBob\x1f2026-01-02\x1f\x1fTwo\x1e";
    const commits = parseLog(text);
    expect(commits).toHaveLength(2);
    expect(commits[0].refs).toEqual(["main", "origin/main"]);
    expect(commits[1].subject).toBe("Two");
  });

  it("reads branches with tracking", () => {
    const text = [
      "*\x1frefs/heads/main\x1fmain\x1forigin/main\x1f[ahead 1, behind 2]\x1fabc\x1fSubj",
      " \x1frefs/heads/old\x1fold\x1forigin/old\x1f[gone]\x1fdef\x1fX",
      " \x1frefs/remotes/origin/main\x1forigin/main\x1f\x1f\x1fabc\x1fSubj",
      " \x1frefs/remotes/origin/HEAD\x1forigin\x1f\x1f\x1fabc\x1fSubj",
    ].join("\n");
    const b = parseBranches(text);
    expect(b.map((x) => x.name)).toEqual(["main", "old", "origin/main"]);
    expect(b[0]).toMatchObject({ current: true, ahead: 1, behind: 2 });
    expect(b[1].gone).toBe(true);
    expect(b[2].remote).toBe(true);
  });

  it("reads remotes and stashes", () => {
    const remotes = parseRemotes(
      "origin\thttps://a:b@h/x.git (fetch)\norigin\thttps://a:b@h/x.git (push)\n",
    );
    expect(remotes).toEqual([
      { name: "origin", fetch: "https://h/x.git", push: "https://h/x.git" },
    ]);
    expect(
      parseStashes("stash@{0}\x1fWIP on main\nstash@{1}\x1fother"),
    ).toEqual([
      { index: 0, name: "stash@{0}", message: "WIP on main" },
      { index: 1, name: "stash@{1}", message: "other" },
    ]);
  });
});

describe("auto pull result", () => {
  it("reads the first marker", () => {
    expect(
      parseAutoResult("@@GIT@@skipped\nThere are uncommitted changes\n"),
    ).toEqual({
      outcome: "skipped",
      message: "There are uncommitted changes",
    });
    expect(parseAutoResult("boom").outcome).toBe("failed");
  });
});
