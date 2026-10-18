import { describe, expect, it } from "vitest";
import { type AppOptions } from "../../src/app/create-app.js";
import { createApp } from "../../src/application/create-app.js";
import { createMemoryLedger } from "../../src/finops/ledger.js";
import { createSqliteTernStore } from "../../src/terns/index.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import {
  ApprovalDesk,
  ChatStart,
  Refund,
  type ButtonClick,
  AuditedRefundsApplication,
  RefundsApplication,
} from "./approval.workflow.js";
import { execute } from "../helpers/flow.js";
import { ExecutionStatus } from "../../src/app/types.js";

function offline(book: ScriptBook): AppOptions {
  return {
    processEnv: {},
    gateway: createScriptedGateway(book),
  };
}

/** The refunds app, its desk, and a run paused at the refund call. */
async function pausedRefund(book: ScriptBook) {
  const app = await createApp(RefundsApplication, offline(book));
  const desk = app.resolve(ApprovalDesk);
  const paused = await execute(app, ChatStart, { text: "refund order A-1" });
  return { app, desk, paused };
}

describe("#188: approval through a @Channel", () => {
  it("AC1: a tool with a channel that pauses asks that channel exactly once", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("agent:clerk-agent")
      .thenReturn(callTool(Refund, { orderId: "A-1" }), replyWith("Refunded."));
    const { app, desk, paused } = await pausedRefund(book);

    expect(paused).toMatchObject({
      status: ExecutionStatus.Paused,
      pause: { agent: "clerk-agent", tool: "refund" },
    });
    expect(desk.posted).toEqual([
      expect.objectContaining({
        agentName: "clerk-agent",
        toolName: "refund",
        toolArguments: { orderId: "A-1" },
      }),
    ]);
    expect(desk.refunded).toEqual([]);

    const click: ButtonClick = { action: "approve", user: "dana" };
    await app.resume(paused.threadId, click);
    expect(desk.posted).toHaveLength(1);
    await app.close();
  });

  it("AC2: an approval delivered through the channel's adapter resumes the run and the tool runs", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("agent:clerk-agent")
      .thenReturn(callTool(Refund, { orderId: "A-1" }), replyWith("Refunded."));
    const { app, desk, paused } = await pausedRefund(book);

    const click: ButtonClick = { action: "approve", user: "dana" };
    const done = await app.resume(paused.threadId, click);

    expect(done).toMatchObject({
      status: ExecutionStatus.Finished,
      finish: { name: "reply-workflow-finish" },
      output: { text: "Refunded." },
      threadId: paused.threadId,
    });
    expect(desk.refunded).toEqual(["A-1"]);
    await app.close();
  });

  it("AC2: a rejection through the channel resumes the run without the tool; the agent gets the reason", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("agent:clerk-agent")
      .thenReturn(callTool(Refund, { orderId: "A-1" }), replyWith("Not refunded."));
    const { app, desk, paused } = await pausedRefund(book);

    const click: ButtonClick = { action: "reject", user: "dana", reason: "over the limit" };
    const done = await app.resume(paused.threadId, click);

    expect(done).toMatchObject({
      status: ExecutionStatus.Finished,
      output: { text: "Not refunded." },
    });
    expect(desk.refunded).toEqual([]);
    expect(JSON.stringify(book.scriptOf("agent:clerk-agent").requests.at(-1))).toContain(
      "over the limit",
    );
    await app.close();
  });

  it("channels are created by the container: an unregistered channel dependency fails the build", async () => {
    await expect(createApp(AuditedRefundsApplication, offline(new ScriptBook()))).rejects.toThrow(
      'AuditedChannel: "AUDIT_LOG" is not registered in @Workflow({ providers })',
    );
  });
});
