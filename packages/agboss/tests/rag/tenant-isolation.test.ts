/**
 * #700 AC1 — tenant isolation through the core: an agent working for tenant A asks what only tenant
 * B's documents say, in tool mode and in context mode, and gets nothing of B; B gets its own. The
 * tenant comes from the execution's frame — none is `context.unavailable`, an id that is no key's
 * text is refused naming the rule, never the id.
 *
 * #722: a cold first app loads the core's subsystems lazily, through vite, in real time — ~200 ms
 * idle, past 5 s on a loaded machine, inside the first test's own timeout. The file warms the whole
 * path once while it is collected (one app, one search to its finish), so each test's timeout
 * bounds its own work only (QUALITY.md → Tests: warm the path first).
 */
import { createAppWith } from "../../src/application/create-app.js";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../src/app/types.js";
import { replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import type { ToolCallTurn } from "../../src/testing/turns.js";
import { resolveTools, type WorkflowServices } from "../../src/workflow.js";
import { workflowOf } from "../../src/testing/workflow-of.js";
import { DtoValidationError } from "../../src/dto/errors.js";
import { ExecutionContextUnavailableError } from "../../src/flow/context/errors.js";
import { inTenantFrame } from "../helpers/frame.js";
import { execute } from "../helpers/flow.js";
import { requestText } from "../pii/boundary.helpers.js";
import {
  ReadStart,
  SearchStart,
  SearchWorkflow,
  TenantDocsApplication,
} from "./fixtures/tenant-docs.application.js";

const QUESTION = "What is the vault code?";
const searchVault: ToolCallTurn = {
  kind: "tool-call",
  tool: "search-tenant-docs-rag-tool",
  args: { query: "vault code" },
};

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function appWith(book: ScriptBook): Promise<App> {
  app = await createAppWith(TenantDocsApplication, { gateway: createScriptedGateway(book) });
  return app;
}

/** One search to its finish on a throwaway app: the lazy loads of every test's path, done once. */
async function warmedPath(): Promise<void> {
  const book = new ScriptBook();
  book.scriptOf("agent:searching-agent").thenReturn(searchVault, replyWith("done"));
  const warm = await createAppWith(TenantDocsApplication, { gateway: createScriptedGateway(book) });
  try {
    await execute(warm, SearchStart, { text: QUESTION }, { tenant: { tenantId: "tenant-a" } });
  } finally {
    await warm.close();
  }
}

await warmedPath();

describe("#700 AC1: tenant A's agent never gets tenant B's passage", () => {
  it.each(["tenant-a", "tenant-b"])(
    "tool mode, as %s: the search returns that tenant's documents only",
    async (tenantId) => {
      const book = new ScriptBook();
      book.scriptOf("agent:searching-agent").thenReturn(searchVault, replyWith("done"));
      const running = await appWith(book);

      const result = await execute(
        running,
        SearchStart,
        { text: QUESTION },
        { tenant: { tenantId } },
      );

      const [search] = result.toolCalls;
      const sources = JSON.stringify(search?.output ?? null);
      expect(sources.includes("plum")).toBe(tenantId === "tenant-b");
      expect(sources).not.toContain(tenantId === "tenant-a" ? "vault.md" : "hours.md");
    },
  );

  it.each(["tenant-a", "tenant-b"])(
    "context mode, as %s: the knowledge block holds that tenant's documents only",
    async (tenantId) => {
      const book = new ScriptBook();
      book.scriptOf("agent:reading-agent").thenReturn(replyWith("done"));
      const running = await appWith(book);

      await execute(running, ReadStart, { text: QUESTION }, { tenant: { tenantId } });

      const sent = requestText(book.scriptOf("agent:reading-agent").lastRequest);
      expect(sent.includes("plum")).toBe(tenantId === "tenant-b");
      expect(sent).not.toContain("hours.md] The office");
    },
  );
});

describe("#700: the tenant comes from the execution's frame, checked, never echoed", () => {
  const services: WorkflowServices = {
    router: (name) => ({ name, route: () => Promise.reject(new Error("unused")) }),
  };
  const searchOf = async () => {
    const bundle = await workflowOf(SearchWorkflow);
    const tool = resolveTools(bundle, services).find((t) => t.name === searchVault.tool);
    if (tool === undefined) throw new Error("no search tool");
    return tool;
  };
  const ctx = { signal: new AbortController().signal, reportCost: () => undefined };

  it("outside an execution: context.unavailable — never the default tenant's documents", async () => {
    const search = await searchOf();

    const output = await search.invoke({ query: "vault" }, ctx);

    expect(output).toMatchObject({ kind: "error" });
    expect(output.kind === "error" ? output.cause : undefined).toBeInstanceOf(
      ExecutionContextUnavailableError,
    );
  });

  it("a frame whose tenant id is no key's text: dto.invalid naming the rule, never the id", async () => {
    const search = await searchOf();
    const tenantId = "tenant-b​";

    const output = await inTenantFrame(tenantId, () => search.invoke({ query: "vault" }, ctx));

    const cause = output.kind === "error" ? output.cause : undefined;
    expect(cause).toBeInstanceOf(DtoValidationError);
    expect((cause as Error).message).toContain("format-character");
    expect((cause as Error).message).not.toContain(tenantId);
  });
});
