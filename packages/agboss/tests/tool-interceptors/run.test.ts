/**
 * #384 — tool interceptors at run time on the whole application: `allow()` runs the tool,
 * `replyToModel({ message })` answers the model instead (the step goes on), `block({ reason })`
 * fails the step with `ToolBlockedError`; `afterToolCall` replaces the result (inner first), which
 * is then bounded by `maxResultSize` and masked by the PII policies; `beforeToolCall` reads the
 * arguments revealed; the four levels and their excludes; MCP tools; a misbehaving interceptor
 * fails the step with its error as the cause.
 */
import type { MessageContent } from "@langchain/core/messages";
import { beforeEach, describe, expect } from "vitest";
import {
  AgentFailedError,
  DtoValidationError,
  StepFailedError,
  ToolBlockedError,
} from "../../src/index.js";
import { callTool, replyWith, testWith, type ModelRequest } from "../../src/testing/index.js";
import type { ModelScript } from "../../src/testing/model-script.js";
import { execute } from "../helpers/flow.js";
import { requestText, tokensIn } from "../pii/boundary.helpers.js";
import {
  QuietAgent,
  QuietStart,
  ScoutAgent,
  ScoutApplication,
  ScoutStart,
} from "./application.fixture.js";
import {
  BoardLookupTool,
  CompanyTool,
  JobBoardServer,
  JobSearchTool,
  PingTool,
  ScopeServiceDownError,
  interceptorLog,
  toolRuns,
} from "./components.fixture.js";

const test = testWith(ScoutApplication);

const acme = { tenant: { tenantId: "acme", allowedCities: ["Haifa"] } } as const;

const textOf = (content: MessageContent | undefined): string =>
  typeof content === "string" ? content : JSON.stringify(content);

/** What the agent's model read last on its second call: the tool call's result. */
function toolMessageOf(script: ModelScript): string {
  const request: ModelRequest | undefined = script.requests[1];
  if (request?.kind !== "chat") throw new Error("expected a second chat request");
  return textOf(request.messages.at(-1)?.text);
}

const byOf = (): string[] => interceptorLog.map((entry) => `${entry.by} ${entry.tool}`);

beforeEach(() => {
  interceptorLog.length = 0;
  toolRuns.length = 0;
});

describe("#384: beforeToolCall decides", () => {
  test("allow(): the tool runs; befores outer first, afters inner first, in the call's frame", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ScoutAgent).thenReturn(callTool(JobSearchTool, { city: "Haifa" }), replyWith("Found."));

    const result = await execute(app, ScoutStart, { text: "jobs in Haifa" }, acme);

    expect(result.output).toEqual({ text: "Found." });
    expect(toolRuns).toEqual(["job-search-tool:Haifa"]);
    expect(byOf()).toEqual([
      "audit:before job-search-tool",
      "scope:before job-search-tool",
      "stamp:after job-search-tool",
      "audit:after job-search-tool",
    ]);
    // the outer afterToolCall reads what the inner one gave
    expect(interceptorLog[3]?.output).toEqual({
      listing: "Engineer in Haifa, write to hr@acme.com (checked)",
    });
    expect(interceptorLog[0]?.idempotencyKey).toMatch(/:scout-agent:1:.+$/);
  });

  test("replyToModel(): the tool does not run, the model reads the message and goes on", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ScoutAgent).thenReturn(
      callTool(JobSearchTool, { city: "Eilat" }),
      replyWith("Eilat is not allowed."),
    );

    const result = await execute(app, ScoutStart, { text: "jobs in Eilat" }, acme);

    expect(result.output).toEqual({ text: "Eilat is not allowed." });
    expect(toolRuns).toEqual([]);
    expect(toolMessageOf(mockLlm(ScoutAgent))).toBe('City "Eilat" is not allowed for this tenant.');
    expect(byOf()).toEqual(["audit:before job-search-tool", "scope:before job-search-tool"]);
  });

  test("block(): the tool does not run, the step fails with ToolBlockedError and the loop's spend", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ScoutAgent).thenReturn(callTool(CompanyTool, { company: "evil-corp" }));

    const run = execute(app, ScoutStart, { text: "about evil-corp" }, acme);

    await expect(run).rejects.toFailWith(ToolBlockedError, {
      code: "step.tool-blocked",
      agent: "scout-agent",
      tool: "company-tool",
      interceptor: "company-block-tool-interceptor",
      reason: "evil-corp is sanctioned",
    });
    const error: unknown = await run.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(StepFailedError);
    // the loop's model call is in the error's spend, so the record and the ledger keep it
    expect((error as ToolBlockedError).usage.map((record) => record.caller)).toEqual([
      "scout-agent",
    ]);
    expect(toolRuns).toEqual([]);
    // the tool excludes the application's audit: only the workflow's, the agent's and its own
    expect(byOf()).toEqual(["scope:before company-tool", "block:before company-tool"]);
    expect(mockLlm(ScoutAgent).requests).toHaveLength(1);
  });
});

describe("#384: a misbehaving interceptor fails the step", () => {
  test("one that throws: AgentFailedError, its error the cause", async ({ app, mockLlm }) => {
    mockLlm(ScoutAgent).thenReturn(callTool(PingTool, { mode: "throw" }));

    const run = execute(app, ScoutStart, { text: "ping" }, acme);

    await expect(run).rejects.toFailWith(AgentFailedError, { cause: ScopeServiceDownError });
    expect(toolRuns).toEqual([]);
  });

  test("one that decides nothing: AgentFailedError naming the factories", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ScoutAgent).thenReturn(callTool(PingTool, { mode: "nothing" }));

    const run = execute(app, ScoutStart, { text: "ping" }, acme);

    await expect(run).rejects.toThrow(/returned no ToolCallDecision/);
    await expect(run).rejects.toBeInstanceOf(AgentFailedError);
  });

  test("an afterToolCall output its tool does not give: DtoValidationError as the cause", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ScoutAgent).thenReturn(callTool(PingTool, { mode: "shape" }));

    const run = execute(app, ScoutStart, { text: "ping" }, acme);

    await expect(run).rejects.toFailWith(AgentFailedError, { cause: DtoValidationError });
    expect(toolRuns).toEqual(["ping-tool:shape"]);
  });
});

describe("#384: the order around PII and maxResultSize", () => {
  test("beforeToolCall reads the arguments revealed; the result is masked after the interceptors", async ({
    app,
    mockLlm,
  }) => {
    const script = mockLlm(ScoutAgent);
    script.thenAnswer((request) => {
      const [token] = tokensIn(requestText(request), "email");
      return script.requests.length === 1
        ? callTool(CompanyTool, { company: token ?? "" })
        : replyWith("Done.");
    });

    await execute(app, ScoutStart, { text: "what does alice@example.com do?" }, acme);

    expect(interceptorLog[1]?.input).toEqual({ company: "alice@example.com" });
    expect(toolRuns).toEqual(["company-tool:alice@example.com"]);
    const read = toolMessageOf(script);
    expect(read).not.toContain("alice@example.com");
    expect(tokensIn(read, "email")).toHaveLength(1);
  });

  test("an afterToolCall's output is cut at maxResultSize, then masked", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ScoutAgent).thenReturn(callTool(PingTool, { mode: "big" }), replyWith("Long."));

    await execute(app, ScoutStart, { text: "ping" }, acme);

    const read = toolMessageOf(mockLlm(ScoutAgent));
    expect(read).toContain("[result truncated:");
    expect(
      Buffer.byteLength(read.split("\n[result truncated")[0] ?? "", "utf8"),
    ).toBeLessThanOrEqual(1024);
  });
});

describe("#384: levels, excludes and MCP tools", () => {
  test("an agent that excludes the application's interceptor: only its tool's own runs", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(QuietAgent).thenReturn(callTool(JobSearchTool, { city: "Eilat" }), replyWith("Ok."));

    await execute(app, QuietStart, { text: "jobs in Eilat" }, acme);

    // no audit (excluded), no tenant scope (another workflow's): Eilat is searched
    expect(byOf()).toEqual(["stamp:after job-search-tool"]);
    expect(toolRuns).toEqual(["job-search-tool:Eilat"]);
  });

  test("an @McpTool is intercepted like a @Tool: allowed, and blocked before its server", async ({
    app,
    mockLlm,
    mcpOf,
  }) => {
    const board = mcpOf(JobBoardServer).thenReturn({
      lookup: () => Promise.resolve({ summary: "acme hires" }),
    });
    mockLlm(ScoutAgent).thenReturn(
      callTool(BoardLookupTool, { company: "acme" }),
      callTool(BoardLookupTool, { company: "evil-corp" }),
    );

    const run = execute(app, ScoutStart, { text: "acme and evil-corp" }, acme);

    await expect(run).rejects.toFailWith(ToolBlockedError, { tool: "board-lookup-tool" });
    expect(board.calls.map((call) => call.tool)).toEqual(["lookup"]);
    expect(byOf().slice(0, 4)).toEqual([
      "audit:before board-lookup-tool",
      "scope:before board-lookup-tool",
      "block:before board-lookup-tool",
      "audit:after board-lookup-tool",
    ]);
  });
});
