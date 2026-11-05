import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createRemote, sudoStdin } from "../../src/backend/remote.js";

function fake(sudoPassword: string, stderr = "", code = 0) {
  const calls: Array<{ command: string; stdin: string }> = [];
  const resolveHost = vi.fn(async () => ({ sudoPassword }));
  const ctx = {
    currentActor: () => "user-1",
    ssh: {
      resolveHost,
      exec: async (_id: number, command: string, opts: { stdin: string }) => {
        calls.push({ command, stdin: opts.stdin });
        const fail = calls.length === 1;
        return {
          stdout: "",
          stderr: fail ? stderr : "",
          code: fail ? code : 0,
          timedOut: false,
        };
      },
    },
  } as unknown as PluginContext;
  return { remote: createRemote(ctx), calls, resolveHost };
}

describe("sudo password", () => {
  it("keeps the password and script out of the command line", async () => {
    const { remote, calls } = fake("s3cret");
    await remote.root(1, true, "echo private");
    expect(calls[0].command).not.toContain("s3cret");
    expect(calls[0].command).not.toContain("sudo");
    expect(calls[0].stdin.split("\n")[1]).toBe("s3cret");
    expect(calls[0].stdin).not.toContain("echo private");
    expect(calls[0].stdin).toContain('bash "$f"');
  });

  it("uses plain sudo with no saved password", async () => {
    const { remote, calls } = fake("");
    await remote.root(1, true, "echo hi");
    expect(calls[0].command).toContain("sudo -n");
    expect(calls[0].stdin).toBe("echo hi");
  });

  it("never reads the password when sudo is off", async () => {
    const { remote, resolveHost } = fake("s3cret");
    await remote.root(1, false, "echo hi");
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("reads the saved password once for a few minutes", async () => {
    const { remote, resolveHost } = fake("s3cret");
    await remote.root(1, true, "a");
    await remote.read(1, true, "b");
    expect(resolveHost).toHaveBeenCalledTimes(1);
  });

  it("reads as the login user when the password is wrong", async () => {
    const { remote, calls } = fake("bad", "Sorry, try again.", 1);
    await remote.read(1, true, "echo hi");
    expect(calls).toHaveLength(2);
    expect(calls[1].stdin).toBe("echo hi");
  });

  it("explains a wrong password on a change", async () => {
    const { remote } = fake("bad", "sudo: 1 incorrect password attempt", 1);
    await expect(remote.root(1, true, "echo hi")).rejects.toThrow(/is wrong/);
  });

  it("refuses a password with a line break", () => {
    expect(() => sudoStdin("x", "a\nb")).toThrow(/line break/);
  });

  const bash = spawnSync("bash", ["-c", "true"]).status === 0;
  it.skipIf(!bash)("writes a script that parses as bash", () => {
    const lines = sudoStdin("echo hi", "it's $a").split("\n");
    // The password line is taken by read, so bash never parses it.
    lines.splice(1, 1);
    const out = spawnSync("bash", ["-n"], { input: lines.join("\n") });
    expect(out.status).toBe(0);
  });
});
