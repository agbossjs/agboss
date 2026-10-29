import { describe, expect, it } from "vitest";
import { ToolCallDecision } from "@agboss/core";
import { ModelProviderMessageRole, type ModelProviderRequest } from "@agboss/core/models";
import { testCompaction, testGuardrail, testTool, testToolInterceptor } from "@agboss/core/testing";
import { CaseNotesCompaction } from "../src/desk/compactions/case-notes/case-notes.compaction.js";
import { NoCredentialsGuardrail } from "../src/desk/guardrails/no-credentials/no-credentials.guardrail.js";
import { DeskAuditToolInterceptor } from "../src/desk/tool-interceptors/desk-audit.tool-interceptor.js";
import { CloseAccountTool } from "../src/desk/tools/close-account.tool.js";
import { OrderStatusTool } from "../src/desk/tools/order-status.tool.js";
import { HarnessModelProvider } from "../src/model-providers/harness.model-provider.js";

/** Each extension point alone, on its own container (#262 S55): the unit runners. */

describe("testToolInterceptor: the decision and the output, per tool", () => {
  const interceptor = testToolInterceptor(DeskAuditToolInterceptor);

  it("blocks a closure, answers for an archived order, allows the rest", async () => {
    const closure = await interceptor.beforeToolCall(CloseAccountTool, { customerId: "c-1" });
    const archived = await interceptor.beforeToolCall(OrderStatusTool, { orderId: "A-1" });
    const recent = await interceptor.beforeToolCall(OrderStatusTool, { orderId: "7" });

    expect(closure.output).toEqual(
      ToolCallDecision.block({ reason: "accounts are closed by the back office only" }),
    );
    expect(archived.output).toEqual(
      ToolCallDecision.replyToModel({
        message: "Order A-1 is archived: ask the customer for a recent one.",
      }),
    );
    expect(recent.output).toEqual(ToolCallDecision.allow());
  });

  it("cuts the internal note from a status", async () => {
    const { output } = await interceptor.afterToolCall(
      OrderStatusTool,
      { orderId: "7" },
      { status: "order 7 shipped | internal: ticket 88" },
    );

    expect(output).toEqual({ status: "order 7 shipped" });
  });
});

it("testCompaction: a custom compaction runs its own code, no model request", async () => {
  const compact = testCompaction(CaseNotesCompaction);

  const { output } = await compact({
    previousSummaries: [],
    turnsToCompact: [
      {
        startName: "desk-workflow-start",
        input: {},
        finishName: "desk-answer-workflow-finish",
        output: {},
      },
    ],
  });

  expect(output.requests).toEqual([]);
  expect(output.summaries).toEqual([
    "1 earlier turn(s): desk-workflow-start → desk-answer-workflow-finish",
  ]);
});

it("testGuardrail: a code guardrail takes no model; a block is an output", async () => {
  const check = testGuardrail(NoCredentialsGuardrail);

  const blocked = await check("my password is hunter2", { element: "desk-agent" });
  const passed = await check("where is #7?", { element: "desk-agent" });

  expect(blocked.output).toMatchObject({ isBlocked: true });
  expect(passed.output).toMatchObject({ isBlocked: false });
});

it("testTool: the tool on its own container, its output validated", async () => {
  const { output } = await testTool(OrderStatusTool)({ orderId: "7" });

  expect(output.status).toMatch(/^order 7 shipped/u);
});

describe("the transport provider answers by the request", () => {
  const request = (messages: ModelProviderRequest["messages"]): ModelProviderRequest => ({
    model: "harness/desk",
    messages,
    tools: [],
    temperature: 0,
    maxTokens: undefined,
    reasoning: { kind: "off" },
    promptCaching: { kind: "off" },
    signal: new AbortController().signal,
  });
  const provider = new HarnessModelProvider();

  it("first a lookup of the #order, then the tool's answer quoted", async () => {
    const first = await provider.complete(
      request([{ role: ModelProviderMessageRole.User, text: "Where is #7?" }]),
    );
    const second = await provider.complete(
      request([
        { role: ModelProviderMessageRole.User, text: "Where is #7?" },
        { role: ModelProviderMessageRole.Tool, text: "shipped", toolCallId: "call-1" },
      ]),
    );

    expect(first.toolCalls).toEqual([
      { id: "call-1", name: "order-status-tool", arguments: { orderId: "7" } },
    ]);
    expect(second.text).toBe("It says: shipped");
  });
});
