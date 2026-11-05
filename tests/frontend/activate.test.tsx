import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

const status = {
  installed: true,
  version: "2.43.0",
  user: "deploy",
  roots: ["~"],
  canEdit: true,
  readOnly: false,
  canRunCommands: false,
};

const repo = (over: Record<string, unknown> = {}) => ({
  path: "/srv/app",
  name: "app",
  branch: "main",
  detached: false,
  upstream: "origin/main",
  ahead: 0,
  behind: 2,
  changed: 1,
  untracked: 0,
  conflicts: 0,
  stashes: 0,
  remoteUrl: "",
  last: {
    hash: "abc",
    subject: "Fix the thing",
    author: "Ann",
    date: "2026-01-01T00:00:00Z",
  },
  ...over,
});

const changesStatus = {
  branch: "main",
  detached: false,
  upstream: "origin/main",
  ahead: 0,
  behind: 2,
  files: [{ path: "src/a.ts", index: ".", tree: "M" }],
};

function api(current: unknown, repos: unknown[] = [repo()]) {
  return {
    get: vi.fn(async (url: string) => ({
      data: url.endsWith("/status")
        ? current
        : url.endsWith("/repos")
          ? { repos }
          : url.includes("/repo/status")
            ? changesStatus
            : {},
    })),
  } as never;
}

const host = { id: 1, name: "web", enableSsh: true };

describe(`${manifest.id} activate`, () => {
  it("registers the host tab and the dashboard card", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.tabs()).toEqual(["git"]);
  });

  it("lists repos with their state", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api(status),
    });
    rendered.renderTab("git", { isVisible: true, host });
    expect(await screen.findByText("app")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText(/1 change/)).toBeTruthy();
  });

  it("opens a repo and shows its changed files", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api(status),
    });
    rendered.renderTab("git", { isVisible: true, host });
    fireEvent.click(await screen.findByText("app"));
    expect(await screen.findByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText(locales.repo.pull)).toBeTruthy();
  });

  it("hides the write buttons from read only callers", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api({ ...status, canEdit: false }),
    });
    rendered.renderTab("git", { isVisible: true, host });
    fireEvent.click(await screen.findByText("app"));
    await screen.findByText("src/a.ts");
    expect(screen.queryByText(locales.repo.pull)).toBeNull();
    expect(screen.queryByText(locales.changes.commit)).toBeNull();
  });

  it("explains when git is missing", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api({ ...status, installed: false }, []),
    });
    rendered.renderTab("git", { isVisible: true, host });
    expect(await screen.findByText(locales.tab.notInstalledTitle)).toBeTruthy();
  });

  it("shows an error when the host cannot be read", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: {
        get: vi.fn(async () => {
          throw new Error("offline");
        }),
      } as never,
    });
    rendered.renderTab("git", { isVisible: true, host });
    expect(await screen.findByText(locales.tab.error)).toBeTruthy();
  });
});
