import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { mcpServerStub, toolOf, workflowOf } from "agboss/testing";
import { createAppDeps, secret } from "agboss";
import { JobScout } from "../src/job-scout.workflow.js";
import { environment as testEnvironment } from "../src/environments/test.environment.js";
import type { AppEnvironment } from "../src/environments/app.environment.js";
import { SHORTLIST_DIR, SHORTLIST_FILE } from "../src/config/paths.js";
import { SaveShortlist } from "../src/mcp/save-shortlist.mcp.js";
import { ShortlistServer } from "../src/mcp/shortlist.server.js";

const job = (n: number) => ({
  title: `Backend Engineer ${String(n)}`,
  company: "Fireblocks",
  location: "Tel Aviv",
  link: `https://example.com/${String(n)}`,
  fit: 80 + n,
});
const env = { OPENROUTER_API_KEY: "k", TERN_DB: ":memory:" };
// these tests run the real providers' wiring: their key is the environment's, from the variable
const environment: AppEnvironment = {
  greenhouseApiUrl: testEnvironment.greenhouseApiUrl,
  sqlitePath: testEnvironment.sqlitePath,
  openRouterApiKey: secret("OPENROUTER_API_KEY"),
};

describe("the shortlist: MCP tools with the server injected (#109)", () => {
  afterAll(async () => {
    await rm(SHORTLIST_DIR, { recursive: true, force: true });
  });

  it("AC4: save-shortlist-tool knows the file and never adds a job twice — through the real server", async () => {
    expect(SHORTLIST_DIR).toContain("job-scout-tests");
    const deps = await createAppDeps(await workflowOf(JobScout), { processEnv: env, environment });
    try {
      const first = await deps.tools("save-shortlist-tool").invoke({ jobs: [job(1), job(2)] });
      const second = await deps.tools("save-shortlist-tool").invoke({ jobs: [job(2), job(3)] });
      const read = await deps.tools("read-shortlist-tool").invoke({});
      const file = await readFile(SHORTLIST_FILE, "utf8");

      expect(first).toEqual({
        kind: "ok",
        value: { added: ["Backend Engineer 1", "Backend Engineer 2"], alreadyThere: [] },
      });
      expect(second).toEqual({
        kind: "ok",
        value: { added: ["Backend Engineer 3"], alreadyThere: ["Backend Engineer 2"] },
      });
      expect(file.split("\n").filter((line) => line.startsWith("- ["))).toEqual([
        "- [Backend Engineer 1 — Fireblocks, Tel Aviv](https://example.com/1) · fit 81%",
        "- [Backend Engineer 2 — Fireblocks, Tel Aviv](https://example.com/2) · fit 82%",
        "- [Backend Engineer 3 — Fireblocks, Tel Aviv](https://example.com/3) · fit 83%",
      ]);
      expect(read).toEqual({ kind: "ok", value: { content: file } });
      expect(deps.config.agents["shortlist-agent"]?.tools).toEqual([
        "read-shortlist-tool",
        "save-shortlist-tool",
      ]);
    } finally {
      await deps.close();
    }
  }, 30_000);

  it("AC4: tested alone with a stub server — a missing file is an empty shortlist", async () => {
    const written: string[] = [];
    const server = mcpServerStub(ShortlistServer, {
      read_text_file: () => Promise.reject(new Error("ENOENT: no such file")),
      write_file: ({ content }) => {
        written.push(content);
        return Promise.resolve({ content: "ok" });
      },
    });

    const saved = await toolOf(new SaveShortlist(server, "/tmp/shortlist.md")).invoke({
      jobs: [job(1)],
    });

    expect(saved).toEqual({
      kind: "ok",
      value: { added: ["Backend Engineer 1"], alreadyThere: [] },
    });
    expect(written).toEqual([
      "# Shortlist\n- [Backend Engineer 1 — Fireblocks, Tel Aviv](https://example.com/1) · fit 81%\n",
    ]);
  });

  it("only the save waits for the user's approval", async () => {
    const workflow = await workflowOf(JobScout);
    const deps = await createAppDeps(workflow, { processEnv: env, environment });
    try {
      // a tool waits for approval when it names a channel (agent-loop/boundary.ts)
      expect(deps.tools("save-shortlist-tool").channel).toBeDefined();
      expect(deps.tools("read-shortlist-tool").channel).toBeUndefined();
      expect(deps.tools("greenhouse-jobs-tool").channel).toBeUndefined();
    } finally {
      await deps.close();
    }
  }, 30_000);

  it("the server may touch only the shortlist folder", async () => {
    const workflow = await workflowOf(JobScout);
    const deps = await createAppDeps(workflow, { processEnv: env, environment });
    try {
      const write = workflow.serverTools?.find((tool) => tool.name === "shortlist__write_file");
      const outside = await write?.invoke({
        path: join(SHORTLIST_DIR, "..", "escape.md"),
        content: "x",
      });

      expect(outside?.kind).toBe("error");
    } finally {
      await deps.close();
    }
  }, 30_000);
});
