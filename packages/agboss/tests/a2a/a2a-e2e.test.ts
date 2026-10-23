import { afterEach, describe, expect, it } from "vitest";
import { A2AAdapter, A2AClient, type A2AEvent } from "../../src/a2a/index.js";
import { createApp } from "../../src/application/create-app.js";
import { callTool, replyWith, failWith, ModelFailure } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { callerOf, DeskReply } from "./fixtures/caller.workflow.js";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import {
  AskStart,
  offline,
  QuickLookup,
  serve,
  SlowLookup,
  slowLookups,
  type Served,
  RemoteDeskApplication,
} from "./fixtures/remote.workflow.js";
import { execute } from "../helpers/flow.js";

import { A2AStatus } from "../../src/a2a/types.js";

let served: Served | undefined;
afterEach(async () => {
  await served?.close();
  served = undefined;
});

async function remote(book: ScriptBook, seen?: (string | undefined)[]) {
  served = await serve(await createApp(RemoteDeskApplication, offline(book)), seen);
  return served;
}

describe("#192 AC1: a workflow exposed over A2A answers with its reply and a final status", () => {
  it("POST /execute → the finish and its output, status finished", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:desk-agent").thenReturn(replyWith("Order 7 shipped"));
    const { url } = await remote(book);

    const response = await new A2AClient({ url }).send({ text: "where is order 7?" });

    expect(response).toMatchObject({
      status: A2AStatus.Finished,
      finish: "answer-workflow-finish",
      output: { text: "Order 7 shipped" },
    });
    expect(response.threadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(book.scriptOf("agent:desk-agent").requests[0]?.input).toContain("where is order 7?");
  });

  it("stream events of the run reach the A2A caller before the final status", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:desk-agent").thenReturn(replyWith("Order 7 shipped"));
    const { url } = await remote(book);
    const events: A2AEvent[] = [];

    const response = await new A2AClient({ url }).send(
      { text: "where is order 7?" },
      { onEvent: (event) => events.push(event) },
    );

    expect(events).toContainEqual({
      type: "progress",
      payload: { step: "text", content: "Order 7 shipped" },
    });
    expect(response).toMatchObject({ status: A2AStatus.Finished });
  });
});

describe("#192: failures map to their statuses", () => {
  it("a failed run → failed, with the error", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:desk-agent").thenReturnAlways(failWith(ModelFailure.ServerError));
    const { url } = await remote(book);

    const response = await new A2AClient({ url }).send({ text: "hi" });

    expect(response).toMatchObject({ status: A2AStatus.Failed });
    expect(response.error).toEqual(expect.any(String));
  });

  it("a run stopped by a limit → limited", async () => {
    const book = new ScriptBook();
    const lookup = callTool(QuickLookup, { orderId: "7" });
    book.scriptOf("agent:desk-agent").thenReturn(lookup, lookup, lookup, replyWith("never"));
    const { url } = await remote(book);

    const response = await new A2AClient({ url }).send({ text: "hi" });

    expect(response).toMatchObject({ status: A2AStatus.Limited });
    expect(response.error).toContain("toolCalls");
  });

  it("cancel(threadId, caller) stops the caller's thread's run in flight → cancelled", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("agent:desk-agent")
      .thenReturn(replyWith("hello"), callTool(SlowLookup, { orderId: "7" }), replyWith("late"));
    const { url, adapter } = await remote(book);
    const client = new A2AClient({ url });
    const first = await client.send({ text: "hi" });
    const started = new Promise<void>((resolve) => {
      slowLookups.started = resolve;
    });

    const threadId = first.threadId ?? "";
    const second = client.send({ text: "look up order 7" }, { threadId });
    await started;
    const elsewhere = adapter.cancel(threadId, { tenant: { tenantId: "globex" } });
    await expect(elsewhere).rejects.toThrow(/thread/i); // another tenant has no such thread
    await adapter.cancel(threadId, {}); // the caller's own: the default tenant

    await expect(second).resolves.toMatchObject({ status: A2AStatus.Cancelled, threadId });
  });
});

describe("#192 AC2: an A2A client agent calls a remote workflow and gets a validated result", () => {
  it("a tool of another workflow injects the @A2AAgent client and gets the remote output", async () => {
    const remoteBook = new ScriptBook();
    remoteBook.scriptOf("agent:desk-agent").thenReturn(replyWith("Order 7 shipped"));
    const seen: (string | undefined)[] = [];
    const { url } = await remote(remoteBook, seen);
    const { CallerApplication, PlanStart, AskDesk, RemoteDeskAgent } = callerOf(url);
    const book = new ScriptBook();
    book
      .scriptOf("agent:planner-agent")
      .thenReturn(callTool(AskDesk, { question: "where is order 7?" }), replyWith("Shipped."));
    const app = await createApp(CallerApplication, offline(book));

    const result = await execute(app, PlanStart, { text: "check order 7" });
    const client = app.resolve<A2AClient>(RemoteDeskAgent);
    await app.close();

    expect(result).toMatchObject({ output: { text: "Shipped." } });
    expect(client.url).toBe(url);
    expect(seen).toEqual(["Bearer secret-42"]);
    expect(JSON.stringify(book.scriptOf("agent:planner-agent").requests[1])).toContain(
      "Order 7 shipped",
    );
  });

  it("a remote output that does not match the DTO is rejected (the tool reports the error)", async () => {
    const remoteBook = new ScriptBook();
    remoteBook.scriptOf("agent:desk-agent").thenReturn(replyWith("Order 7 shipped"));
    const { url } = await remote(remoteBook);
    const { CallerApplication, PlanStart, AskTicket } = callerOf(url);
    const book = new ScriptBook();
    book
      .scriptOf("agent:planner-agent")
      .thenReturn(callTool(AskTicket, { question: "ticket?" }), replyWith("No ticket."));
    const app = await createApp(CallerApplication, offline(book));

    await execute(app, PlanStart, { text: "open a ticket" });
    await app.close();

    const toolResult = JSON.stringify(book.scriptOf("agent:planner-agent").requests[1]);
    expect(toolResult).toContain("TicketedReply");
    expect(toolResult).toContain("ticket");
  });

  it("a remote run that does not answer throws A2ARemoteError with its status", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:desk-agent").thenReturnAlways(failWith(ModelFailure.ServerError));
    const { url } = await remote(book);

    const contract = {
      target: { application: "remote-desk-application", start: "ask-workflow-start" },
      input: WorkflowStartTextDto,
      output: DeskReply,
    };
    const call = new A2AClient({ url, contract }).execute({ text: "x" });

    await expect(call).rejects.toMatchObject({
      name: "A2ARemoteError",
      response: { status: A2AStatus.Failed },
    });
  });
});

describe("#261: an A2A call runs on the typed contexts its transport gives", () => {
  it("execute with tenant values: the thread is the tenant's; a resume names it by tenantId", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:desk-agent").thenReturn(replyWith("one"), replyWith("two"));
    const app = await createApp(RemoteDeskApplication, offline(book));
    const adapter = new A2AAdapter(app);
    const caller = { tenant: { tenantId: "acme" }, ownerId: "dana" };

    const first = await adapter.execute(AskStart, { input: { text: "hi" } }, undefined, caller);
    const second = await adapter.execute(
      AskStart,
      { input: { text: "again" }, threadId: first.threadId ?? "" },
      undefined,
      caller,
    );
    const elsewhere = adapter.cancel(first.threadId ?? "", {});

    expect([first.status, second.status]).toEqual([A2AStatus.Finished, A2AStatus.Finished]);
    expect(second.threadId).toBe(first.threadId);
    await expect(elsewhere).rejects.toThrow(/thread/i);
    await expect(adapter.cancel(first.threadId ?? "", caller)).resolves.toBeUndefined();
    await app.close();
  });
});
