import { describe, expect, it } from "vitest";
import { type AppOptions } from "../../src/app/create-app.js";
import { createApp } from "../../src/application/create-app.js";
import { createSqliteTernStore } from "../../src/terns/index.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import {
  ApprovalDesk,
  ChatStart,
  Refund,
  AuditedRefundsApplication,
  RefundsApplication,
} from "./approval.workflow.js";
import { execute } from "../helpers/flow.js";
import type { ResumeRequest } from "../../src/app/types.js";
import { ExecutionStatus } from "../../src/app/types.js";

function offline(book: ScriptBook): AppOptions {
  return {
    processEnv: {},
    gateway: createScriptedGateway(book),
  };
}

/** Who answers through the desk (a `PauseAnswerer.Channel` role: the desk knows its staff). */
const dana = { answeredBy: "dana" };

/** The answer to the desk's first ask: by the `pauseId` the channel was sent. */
function deskAnswer(desk: ApprovalDesk, decision: unknown): ResumeRequest {
  const [ask] = desk.posted;
  if (ask === undefined) throw new Error("the desk was asked nothing");
  return { pauseId: ask.pauseId, decision };
}

/** The refunds app, its desk, and a run paused at the refund call. */
async function pausedRefund(book: ScriptBook) {
  const app = await createApp(RefundsApplication, offline(book));
  const desk = app.resolve(ApprovalDesk);
  const paused = await execute(app, ChatStart, { text: "refund order A-1" });
  return { app, desk, paused };
}

describe("#261: a channel reads the execution through its ExecutionContext", () => {
  it("the ask is made inside the paused step: the injected context gives its tenant", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("agent:clerk-agent")
      .thenReturn(callTool(Refund, { orderId: "A-1" }), replyWith("Refunded."));
    const app = await createApp(RefundsApplication, offline(book));
    const desk = app.resolve(ApprovalDesk);

    await execute(app, ChatStart, { text: "refund order A-1" }, { tenant: { tenantId: "acme" } });

    expect(desk.tenants).toEqual(["acme"]);
    expect(Object.keys(desk.posted[0] ?? {})).toEqual(["pauseId", "value"]);
    await app.close();
  });
});

describe("#188: approval through a @Channel", () => {
  it("AC1: a tool with a channel that pauses asks that channel exactly once", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("agent:clerk-agent")
      .thenReturn(callTool(Refund, { orderId: "A-1" }), replyWith("Refunded."));
    const { app, desk, paused } = await pausedRefund(book);

    expect(paused).toMatchObject({
      status: ExecutionStatus.Paused,
      pending: [{ agent: "clerk-agent", ask: { tool: "refund-tool" } }],
    });
    expect(desk.posted).toEqual([
      {
        pauseId: expect.stringMatching(/^[0-9a-f]{32}$/),
        value: expect.objectContaining({ tool: "refund-tool", arguments: { orderId: "A-1" } }),
      },
    ]);
    expect(desk.refunded).toEqual([]);

    await app.resume(deskAnswer(desk, { approved: true }), dana);
    expect(desk.posted).toHaveLength(1);
    await app.close();
  });

  it("AC2: an approval resumes the run and the tool runs", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("agent:clerk-agent")
      .thenReturn(callTool(Refund, { orderId: "A-1" }), replyWith("Refunded."));
    const { app, desk, paused } = await pausedRefund(book);

    const done = await app.resume(deskAnswer(desk, { approved: true }), dana);

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

    const done = await app.resume(
      deskAnswer(desk, { approved: false, reason: "over the limit" }),
      dana,
    );

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
      'AuditedRefundApprovalChannel: "AUDIT_LOG" is not registered in @Workflow({ providers })',
    );
  });
});
