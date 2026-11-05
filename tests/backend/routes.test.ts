import { afterEach, describe, expect, it } from "vitest";
import { startServer, type TestServer } from "./helpers";

let s: TestServer | null = null;

afterEach(async () => {
  await s?.close();
  s = null;
});

const INFO = (path: string) =>
  [
    "@@GIT@@repo",
    path,
    "@@GIT@@status",
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +1 -2",
    "1 .M N... 100644 100644 100644 a b f.ts",
    "@@GIT@@last",
    "abc\x1fAnn\x1f2026-01-01T00:00:00+00:00\x1fSubject",
    "@@GIT@@remote",
    "git@github.com:o/r.git",
    "@@GIT@@stash",
    "0",
    "",
  ].join("\n");

async function withRepo(options: Parameters<typeof startServer>[0] = {}) {
  s = await startServer(options);
  s.ssh.replies.push({ match: "--show-toplevel", stdout: "/srv/app\n" });
  s.ssh.replies.push({
    match: "--untracked-files=normal",
    stdout: INFO("/srv/app"),
  });
  const added = await s.request("POST", "/1/repos", { paths: ["/srv/app"] });
  return { server: s, added };
}

describe("status", () => {
  it("reports git and the access of the caller", async () => {
    s = await startServer({ level: "connect" });
    s.ssh.replies.push({
      match: "git --version",
      stdout: "version=2.43.0\nuser=deploy\n",
    });
    const res = await s.request("GET", "/1/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      installed: true,
      version: "2.43.0",
      user: "deploy",
      canEdit: false,
      roots: ["~"],
    });
  });

  it("says git is missing on exit 127", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "git --version", code: 127 });
    const res = await s.request("GET", "/1/status");
    expect(res.body.installed).toBe(false);
  });

  it("refuses hosts with Git turned off", async () => {
    s = await startServer({ settings: { enableGit: false } });
    const res = await s.request("GET", "/1/status");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("disabled");
  });

  it("refuses callers without the permission", async () => {
    s = await startServer({ permissions: [] });
    expect((await s.request("GET", "/1/status")).status).toBe(403);
  });
});

describe("repos", () => {
  it("adds a repo by its top folder and lists it with its state", async () => {
    const { server, added } = await withRepo();
    expect(added.body.added).toEqual(["/srv/app"]);
    const res = await server.request("GET", "/1/repos");
    expect(res.body.repos[0]).toMatchObject({
      path: "/srv/app",
      name: "app",
      branch: "main",
      ahead: 1,
      behind: 2,
      changed: 1,
      remoteUrl: "git@github.com:o/r.git",
    });
  });

  it("needs edit access to add or remove", async () => {
    s = await startServer({ level: "connect" });
    const add = await s.request("POST", "/1/repos", { paths: ["/srv/app"] });
    expect(add.status).toBe(403);
    expect(add.body.code).toBe("HOST_EDIT_REQUIRED");
    const del = await s.request("DELETE", "/1/repos?path=%2Fsrv%2Fapp");
    expect(del.status).toBe(403);
  });

  it("refuses bad folders before touching the host", async () => {
    s = await startServer();
    const res = await s.request("POST", "/1/repos", {
      paths: ["relative/dir"],
    });
    expect(res.status).toBe(400);
    expect(s.ssh.calls).toHaveLength(0);
  });

  it("refuses a folder that is not a repo", async () => {
    s = await startServer();
    s.ssh.replies.push({
      match: "--show-toplevel",
      stdout: "That folder is not a git repo",
      code: 3,
    });
    const res = await s.request("POST", "/1/repos", { paths: ["/tmp"] });
    expect(res.status).toBe(400);
  });

  it("forgets a repo without touching the host", async () => {
    const { server } = await withRepo();
    const calls = server.ssh.calls.length;
    const res = await server.request("DELETE", "/1/repos?path=%2Fsrv%2Fapp");
    expect(res.status).toBe(200);
    expect(server.ssh.calls.length).toBe(calls);
    expect((await server.request("GET", "/1/repos")).body.repos).toEqual([]);
  });
});

describe("repo routes only work for added repos", () => {
  it("answers 404 for a folder that was never added", async () => {
    s = await startServer();
    const res = await s.request("GET", "/1/repo/status?path=%2Fetc");
    expect(res.status).toBe(404);
    expect(s.ssh.calls).toHaveLength(0);
  });

  it("answers 404 for changes too", async () => {
    s = await startServer();
    const res = await s.request("POST", "/1/repo/pull", { path: "/etc" });
    expect(res.status).toBe(404);
  });
});

describe("changes", () => {
  it("pull runs fast forward only and returns the output", async () => {
    const { server } = await withRepo();
    server.ssh.replies.unshift({
      match: "git pull --ff-only",
      stdout: "Already up to date.",
    });
    const res = await server.request("POST", "/1/repo/pull", {
      path: "/srv/app",
    });
    expect(res.body).toEqual({ ok: true, output: "Already up to date." });
    const last = server.ssh.calls.at(-1)!;
    expect(last.stdin).toContain("git pull --ff-only");
    expect(last.stdin).not.toContain("--force");
  });

  it("reports a failed push as ok false", async () => {
    const { server } = await withRepo();
    server.ssh.replies.unshift({
      match: "git push",
      stdout: "rejected",
      code: 1,
    });
    const res = await server.request("POST", "/1/repo/push", {
      path: "/srv/app",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, output: "rejected" });
  });

  it("blocks changes on read only hosts", async () => {
    const { server } = await withRepo();
    server.mock.settings.set("host:1:readOnly", true);
    const res = await server.request("POST", "/1/repo/pull", {
      path: "/srv/app",
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("readOnly");
  });

  it("validates branch names and files", async () => {
    const { server } = await withRepo();
    const calls = server.ssh.calls.length;
    expect(
      (
        await server.request("POST", "/1/repo/checkout", {
          path: "/srv/app",
          branch: "-D",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await server.request("POST", "/1/repo/stage", {
          path: "/srv/app",
          files: ["../../etc/passwd"],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await server.request("POST", "/1/repo/commit", {
          path: "/srv/app",
          message: "  ",
        })
      ).status,
    ).toBe(400);
    expect(server.ssh.calls.length).toBe(calls);
  });

  it("reads the diff of a file", async () => {
    const { server } = await withRepo();
    server.ssh.replies.unshift({ match: "git diff", stdout: "+new\n-old\n" });
    const res = await server.request(
      "GET",
      "/1/repo/diff?path=%2Fsrv%2Fapp&file=f.ts&mode=staged",
    );
    expect(res.body).toEqual({ text: "+new\n-old\n", truncated: false });
    expect(server.ssh.calls.at(-1)!.stdin).toContain(
      "git diff --no-color --cached",
    );
  });
});

describe("auto pull", () => {
  it("saves the setup for the signed in user", async () => {
    const { server } = await withRepo();
    const res = await server.request("PUT", "/1/repo/auto", {
      path: "/srv/app",
      enabled: true,
      intervalMin: 30,
    });
    expect(res.status).toBe(200);
    expect(res.body.auto).toMatchObject({ enabled: true, intervalMin: 30 });
    const repos = await server.request("GET", "/1/repos");
    expect(repos.body.repos[0].auto.enabled).toBe(true);
  });

  it("needs edit access", async () => {
    s = await startServer({ level: "connect" });
    const res = await s.request("PUT", "/1/repo/auto", {
      path: "/srv/app",
      enabled: true,
    });
    expect(res.status).toBe(403);
  });

  it("refuses a post command without the permission", async () => {
    const { server } = await withRepo();
    const res = await server.request("PUT", "/1/repo/auto", {
      path: "/srv/app",
      enabled: true,
      postCommand: "make deploy",
    });
    expect(res.status).toBe(403);
  });

  it("runs now and keeps the run list", async () => {
    const { server } = await withRepo();
    await server.request("PUT", "/1/repo/auto", {
      path: "/srv/app",
      enabled: true,
      intervalMin: 5,
    });
    server.ssh.replies.unshift({
      match: "git merge --ff-only",
      stdout: "@@GIT@@pulled\nPulled 2 commit(s)\n",
    });
    const run = await server.request("POST", "/1/repo/auto/run", {
      path: "/srv/app",
    });
    expect(run.body.run).toMatchObject({
      outcome: "pulled",
      message: "Pulled 2 commit(s)",
    });
    const repos = await server.request("GET", "/1/repos");
    expect(repos.body.repos[0].auto.runs).toHaveLength(1);
    expect(repos.body.repos[0].auto.failing).toBe(false);
  });

  it("marks a repo failing after a failed run", async () => {
    const { server } = await withRepo();
    await server.request("PUT", "/1/repo/auto", {
      path: "/srv/app",
      enabled: true,
    });
    server.ssh.replies.unshift({
      match: "git merge --ff-only",
      stdout: "@@GIT@@failed\nPermission denied (publickey)\n",
    });
    const run = await server.request("POST", "/1/repo/auto/run", {
      path: "/srv/app",
    });
    expect(run.body.run.outcome).toBe("failed");
    const repos = await server.request("GET", "/1/repos");
    expect(repos.body.repos[0].auto.failing).toBe(true);
  });
});

describe("summary", () => {
  it("lists repos on hosts with Git turned on", async () => {
    const { server } = await withRepo();
    const res = await server.request("GET", "/summary");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
