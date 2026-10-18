/** #202 AC1: a thread belongs to its owner — another owner cannot continue, resume or cancel it. */
import { describe, expect, it } from "vitest";
import { type AppOptions } from "../../src/app/create-app.js";
import { createApp } from "../../src/application/create-app.js";
import { ThreadOwnerError } from "../../src/index.js";
import { resetSharedDatabase } from "../helpers/shared-infrastructure.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { ApprovalDesk, ChatStart, type ButtonClick } from "../channels/approval.workflow.js";
import {
  DurablePaymentsApplication,
  Pay,
  PaymentLog,
  PaymentsApplication,
} from "./isolation.workflow.js";
import { execute } from "../helpers/flow.js";
import { ExecutionStatus } from "../../src/app/types.js";

const offline = (book: ScriptBook): AppOptions => ({
  processEnv: {},
  gateway: createScriptedGateway(book),
});

const approve: ButtonClick = { action: "approve", user: "dana" };
const card = { orderId: "A-1", cardNumber: "4111 1111 1111 1111" };

describe("#202 AC1: threads are bound to their owner", () => {
  it("AC1: another owner cannot continue a thread — nothing runs, its history is never read", async () => {
    const book = new ScriptBook();
    const cashier = book.scriptOf("agent:cashier-agent").thenReturnAlways(replyWith("Hello."));
    const app = await createApp(PaymentsApplication, offline(book));
    const first = await execute(app, ChatStart, { text: "my card is 4111" }, { ownerId: "alice" });

    const intruder = execute(
      app,
      ChatStart,
      { text: "what was my card?" },
      {
        threadId: first.threadId,
        ownerId: "bob",
      },
    );
    await expect(intruder).rejects.toBeInstanceOf(ThreadOwnerError);
    await expect(intruder).rejects.toMatchObject({ code: "run.thread-owner" });
    await expect(intruder).rejects.not.toThrow(/alice/);
    const anonymous = execute(app, ChatStart, { text: "hi" }, { threadId: first.threadId });
    await expect(anonymous).rejects.toMatchObject({ code: "run.thread-owner" });
    expect(cashier.requests).toHaveLength(1);

    const again = await execute(
      app,
      ChatStart,
      { text: "thanks" },
      {
        threadId: first.threadId,
        ownerId: "alice",
      },
    );
    expect(again).toMatchObject({ status: ExecutionStatus.Finished, threadId: first.threadId });
    expect(cashier.requests).toHaveLength(2);
    await app.close();
  });

  it("AC1: another owner cannot resume or cancel a paused run; its owner resumes it", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:cashier-agent").thenReturn(callTool(Pay, card), replyWith("Paid."));
    const app = await createApp(PaymentsApplication, offline(book));
    const log = app.resolve(PaymentLog);
    const paused = await execute(app, ChatStart, { text: "pay A-1" }, { ownerId: "alice" });
    expect(paused).toMatchObject({ status: ExecutionStatus.Paused, pause: { tool: "pay" } });

    await expect(app.resume(paused.threadId, approve, { ownerId: "bob" })).rejects.toBeInstanceOf(
      ThreadOwnerError,
    );
    await expect(app.cancel(paused.threadId, { ownerId: "bob" })).rejects.toBeInstanceOf(
      ThreadOwnerError,
    );
    await expect(app.resume(paused.threadId, approve)).rejects.toBeInstanceOf(ThreadOwnerError);
    expect(log.owners).toEqual([]);

    const done = await app.resume(paused.threadId, approve, { ownerId: "alice" });
    expect(done).toMatchObject({ status: ExecutionStatus.Finished, output: { text: "Paid." } });
    expect(log.owners).toEqual(["alice"]);
    await app.close();
  });

  it("AC1: the owner cancels its own paused run; threads without an owner work as before", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:cashier-agent").thenReturn(callTool(Pay, card), replyWith("Hi."));
    const app = await createApp(PaymentsApplication, offline(book));
    const paused = await execute(app, ChatStart, { text: "pay A-1" }, { ownerId: "alice" });

    expect(await app.cancel(paused.threadId, { ownerId: "alice" })).toEqual({ cancelled: true });
    const open = await execute(app, ChatStart, { text: "hi" });
    expect(open.status).toBe(ExecutionStatus.Finished);
    await expect(app.cancel(open.threadId, { ownerId: "bob" })).rejects.toBeInstanceOf(
      ThreadOwnerError,
    );
    expect(await app.cancel(open.threadId)).toEqual({ cancelled: false });
    expect(app.resolve(ApprovalDesk).posted).toHaveLength(1);
    await app.close();
  });

  it("AC1: the binding is stored with the thread — an app over the same database keeps it", async () => {
    resetSharedDatabase();
    const book = new ScriptBook();
    book.scriptOf("agent:cashier-agent").thenReturnAlways(replyWith("Hello."));
    const first = await createApp(DurablePaymentsApplication, offline(book));
    const { threadId: thread } = await execute(
      first,
      ChatStart,
      { text: "hi" },
      { ownerId: "alice" },
    );
    await first.close();

    const second = await createApp(DurablePaymentsApplication, offline(book));
    const intruder = execute(
      second,
      ChatStart,
      { text: "hi" },
      { threadId: thread, ownerId: "bob" },
    );
    await expect(intruder).rejects.toBeInstanceOf(ThreadOwnerError);
    const own = await execute(
      second,
      ChatStart,
      { text: "hi" },
      { threadId: thread, ownerId: "alice" },
    );
    expect(own.threadId).toBe(thread);
    await second.close();
  });
});
