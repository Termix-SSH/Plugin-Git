import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseAutoResult,
  parseBranches,
  parseInfo,
  parseLog,
  parseStatus,
} from "../../src/backend/parse.js";
import {
  actions,
  autoPullScript,
  branchesScript,
  cleanBranch,
  cleanFile,
  cleanFiles,
  cleanHash,
  cleanPath,
  cleanRef,
  cleanUrl,
  infoScript,
  logScript,
  pathExpr,
  statusScript,
} from "../../src/backend/scripts.js";

describe("validation", () => {
  it("accepts absolute and home paths only", () => {
    expect(cleanPath("/srv/app/")).toBe("/srv/app");
    expect(cleanPath("~/code")).toBe("~/code");
    expect(cleanPath("~")).toBe("~");
    for (const bad of ["", "app", "../x", "/a\nb", "/a\0b", 5, null]) {
      expect(() => cleanPath(bad)).toThrow();
    }
  });

  it("keeps ~ for the host to expand and quotes the rest", () => {
    expect(pathExpr("~")).toBe('"$HOME"');
    expect(pathExpr("~/my app")).toBe(`"$HOME"/'my app'`);
    expect(pathExpr("/srv/it's")).toBe(String.raw`'/srv/it'\''s'`);
  });

  it("refuses branch names that could be options or tricks", () => {
    expect(cleanBranch("feature/x-1")).toBe("feature/x-1");
    for (const bad of [
      "-D",
      "a..b",
      "a b",
      "a;rm",
      "x.lock",
      "/x",
      "x/",
      "a$(b)",
    ]) {
      expect(() => cleanBranch(bad)).toThrow();
    }
    expect(() => cleanRef("--upload-pack=x")).toThrow();
    expect(cleanRef("origin/main~2")).toBe("origin/main~2");
  });

  it("checks hashes, files and addresses", () => {
    expect(cleanHash("ABCDEF1")).toBe("abcdef1");
    expect(() => cleanHash("xyz")).toThrow();
    expect(cleanFile("src/a b.ts")).toBe("src/a b.ts");
    for (const bad of ["/etc/passwd", "../x", "a/../../b", "a\nb", ""]) {
      expect(() => cleanFile(bad)).toThrow();
    }
    expect(() => cleanFiles(new Array(501).fill("a"))).toThrow();
    expect(cleanUrl("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
    expect(cleanUrl("https://github.com/o/r.git")).toBeTruthy();
    for (const bad of [
      "--upload-pack=x",
      "ext::sh -c x",
      "file:///etc",
      "a b",
    ]) {
      expect(() => cleanUrl(bad)).toThrow();
    }
  });

  it("sends commit messages as base64, never in the script text", () => {
    const script = actions.commit("/srv/app", "it's $(bad) `x`", false);
    expect(script).not.toContain("$(bad)");
    expect(script).toContain("base64 -d");
  });
});

function bash(script: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-s"], {
    input: script,
    encoding: "utf8",
    env: {
      ...process.env,
      // Keep the developer's own git config (like commit signing) out.
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Tester",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "Tester",
      GIT_COMMITTER_EMAIL: "t@example.com",
      ...env,
    },
  });
}

const haveGit = (() => {
  const r = spawnSync("bash", ["-c", "git --version && mktemp -d"], {
    encoding: "utf8",
  });
  return r.status === 0;
})();

describe.skipIf(!haveGit)("scripts against real git", () => {
  let root = "";
  let a = "";
  let b = "";

  const ok = (script: string) => {
    const r = bash(script);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    return r.stdout;
  };

  beforeAll(() => {
    root = ok("mktemp -d").trim();
    a = `${root}/a`;
    b = `${root}/b`;
    ok(`set -e
git init -q --bare -b main ${root}/remote.git
git clone -q ${root}/remote.git ${a} 2>/dev/null
cd ${a} && git checkout -q -b main 2>/dev/null || true
echo one > f && git add f && git commit -qm one && git push -q -u origin main
git clone -q ${root}/remote.git ${b}
`);
  });

  afterAll(() => {
    if (root) bash(`rm -rf ${root}`);
  });

  const pushFromA = (name: string) =>
    ok(
      `cd ${a} && echo ${name} >> f && git commit -qam ${name} && git push -q`,
    );
  const reset = () =>
    ok(
      `cd ${b} && git fetch -q && git checkout -q main && git reset -q --hard origin/main && git clean -fdq`,
    );

  it("reads many repos in one go", () => {
    const out = ok(infoScript([b, `${root}/nope`]));
    const [repo, missing] = parseInfo(out);
    expect(repo.status?.branch).toBe("main");
    expect(repo.status?.upstream).toBe("origin/main");
    expect(repo.last?.subject).toBe("one");
    expect(missing.error).toBe("missing");
  });

  it("pulls when behind, then reports up to date", () => {
    pushFromA("two");
    const first = parseAutoResult(ok(autoPullScript(b, "")));
    expect(first.outcome).toBe("pulled");
    const second = parseAutoResult(ok(autoPullScript(b, "")));
    expect(second.outcome).toBe("uptodate");
  });

  it("runs the post command only after a pull", () => {
    pushFromA("three");
    const r = parseAutoResult(ok(autoPullScript(b, "echo done > post.txt")));
    expect(r.outcome).toBe("pulled");
    expect(ok(`cat ${b}/post.txt`).trim()).toBe("done");
    ok(`rm ${b}/post.txt`);
    const again = parseAutoResult(
      ok(autoPullScript(b, "echo again > post.txt")),
    );
    expect(again.outcome).toBe("uptodate");
    expect(bash(`test -e ${b}/post.txt`).status).not.toBe(0);
  });

  it("skips a repo with uncommitted changes", () => {
    pushFromA("four");
    ok(`echo dirty >> ${b}/f`);
    const r = parseAutoResult(ok(autoPullScript(b, "")));
    expect(r.outcome).toBe("skipped");
    expect(r.message).toMatch(/uncommitted/);
    reset();
  });

  it("skips a diverged branch", () => {
    ok(`cd ${b} && echo local >> g && git add g && git commit -qm local`);
    pushFromA("five");
    const r = parseAutoResult(ok(autoPullScript(b, "")));
    expect(r.outcome).toBe("skipped");
    expect(r.message).toMatch(/diverged/);
    ok(`cd ${b} && git reset -q --hard origin/main`);
  });

  it("fails clearly when the folder is gone", () => {
    const r = parseAutoResult(ok(autoPullScript(`${root}/gone`, "")));
    expect(r.outcome).toBe("failed");
  });

  it("reads status with odd file names", () => {
    reset();
    ok(`cd ${b} && echo x > 'with space.txt' && echo y >> f`);
    const s = parseStatus(ok(statusScript(b)), true);
    expect(s.files.map((f) => f.path).sort()).toEqual(["f", "with space.txt"]);
    expect(s.untracked).toBe(1);
    expect(s.changed).toBe(1);
  });

  it("stages, commits with a tricky message and shows it in the log", () => {
    reset();
    ok(`cd ${b} && echo z > z.txt`);
    ok(actions.stage(b, ["z.txt"], false));
    const message = "feat: it's $(whoami) `id`\n\nbody line";
    const out = bash(actions.commit(b, message, false));
    expect(out.status, out.stdout).toBe(0);
    const [top] = parseLog(ok(logScript(b, { limit: 1, skip: 0, all: false })));
    expect(top.subject).toBe("feat: it's $(whoami) `id`");
    ok(`cd ${b} && git reset -q --hard origin/main`);
  });

  it("undoes a merge with conflicts", () => {
    reset();
    ok(
      `cd ${b} && git checkout -q -b side && echo side > f && git commit -qam side && git checkout -q main && echo main > f && git commit -qam mainchange`,
    );
    const r = bash(actions.merge(b, "side"));
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/undone/);
    const s = parseStatus(ok(statusScript(b)), true);
    expect(s.conflicts).toBe(0);
    expect(s.files).toHaveLength(0);
    ok(`cd ${b} && git branch -D side -q && git reset -q --hard origin/main`);
  });

  it("lists branches and refuses to delete an unmerged one without force", () => {
    ok(
      `cd ${b} && git checkout -q -b topic && echo t > t && git add t && git commit -qm topic && git checkout -q main`,
    );
    const names = parseBranches(ok(branchesScript(b))).map((x) => x.name);
    expect(names).toContain("topic");
    expect(bash(actions.deleteBranch(b, "topic", false)).status).not.toBe(0);
    expect(bash(actions.deleteBranch(b, "topic", true)).status).toBe(0);
  });

  it("keeps a failing git from eating the script", () => {
    // git must not read the rest of the script from stdin
    const r = bash(`${actions.fetch(b)}\necho after`);
    expect(r.stdout).toContain("after");
  });
});
