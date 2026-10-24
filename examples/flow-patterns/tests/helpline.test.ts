import { expect } from "vitest";
import { A2ACallerRejectedError, A2AClient } from "agboss/a2a";
import { callTool, replyWith, testWith } from "agboss/testing";
import { DeskA2aCallerResolver } from "../src/desk/a2a/desk.a2a-caller-resolver.js";
import { DeskA2AExpose } from "../src/desk/a2a/desk.a2a-expose.js";
import { DeskAgent } from "../src/desk/agents/desk.agent.js";
import { OrderStatusTool } from "../src/desk/tools/order-status.tool.js";
import { DeskApplication } from "../src/desk.application.js";
import { FlowPatternsApplication } from "../src/flow-patterns.application.js";
import { DeskA2AAgent } from "../src/helpline/a2a/desk.a2a-agent.js";
import { HelplineAgent } from "../src/helpline/agents/helpline.agent.js";
import { DeskCallDto, DeskReplyDto } from "../src/helpline/dtos/desk-call.dto.js";
import { AskDeskTool } from "../src/helpline/tools/ask-desk.tool.js";
import { HelplineAnswerWorkflowFinish } from "../src/helpline/workflow-finishes/helpline-answer.workflow-finish.js";
import { HelplineWorkflowStart } from "../src/helpline/workflow-starts/helpline.workflow-start.js";

/**
 * Two applications over A2A (#387, #398): `desk-application` serves its start, the helpline of
 * `flow-patterns-application` consumes it through the declared contract `DeskA2AAgent`. The
 * producer is served on the loopback by the `a2aServer` fixture; `npm run check` compares the
 * contract with the desk's `describe --json` (`check --federation`).
 */

const deskTest = testWith(DeskApplication);
const desk = { expose: DeskA2AExpose, callerResolver: DeskA2aCallerResolver };

/** The helpline's side of the contract, as `DeskA2AAgent` declares it. */
const helplineClient = (url: string, headers: Record<string, string> = {}) =>
  new A2AClient({
    url,
    headers,
    contract: {
      target: { application: "desk-application", start: "desk-workflow-start" },
      input: DeskCallDto,
      output: DeskReplyDto,
    },
  });

deskTest("the desk answers the helpline's contract over A2A", async ({ a2aServer, mockLlm }) => {
  mockLlm(DeskAgent).thenReturn(
    callTool(OrderStatusTool, { orderId: "7" }),
    replyWith("Order 7 shipped on Monday."),
  );
  const { url } = await a2aServer(desk);

  const reply = await helplineClient(url, { "x-tenant-id": "helpline" }).execute({
    customerId: "c-1",
    question: "Where is #7?",
  });

  expect(reply).toEqual({ text: "Order 7 shipped on Monday." });
});

deskTest(
  "a caller naming no tenant is refused, and nothing runs",
  async ({ a2aServer, mockLlm }) => {
    const { url } = await a2aServer(desk);

    const sent = helplineClient(url).send({ customerId: "c-1", question: "Where is #7?" });

    await expect(sent).rejects.toFailWith(A2ACallerRejectedError, {
      httpStatus: 401,
      wireCode: "a2a.caller-unauthenticated",
    });
    expect(mockLlm(DeskAgent)).toHaveBeenCalledTimes(0);
  },
);

const test = testWith(FlowPatternsApplication);

test("the helpline's tool calls the desk through its contract", async ({
  app,
  mockLlm,
  mockOf,
}) => {
  const deskAgent = mockOf(DeskA2AAgent); // the remote application, replaced before the app starts
  deskAgent.execute.mockResolvedValue({ text: "Order 7 shipped on Monday." });
  mockLlm(HelplineAgent).thenReturn(
    callTool(AskDeskTool, { customerId: "c-1", question: "Where is #7?" }),
    replyWith("The desk says order 7 shipped on Monday."),
  );

  const result = await app.execute(HelplineWorkflowStart, { text: "c-1: where is #7?" });

  expect(result).toHaveToolCallMatching(AskDeskTool, { customerId: "c-1" });
  const calls = deskAgent.execute.mock.calls;
  expect(calls.map(([sent]) => sent)).toEqual([{ customerId: "c-1", question: "Where is #7?" }]);
  expect(calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal); // the tool call's: cancel, timeout
  expect(result).toFinishWith(HelplineAnswerWorkflowFinish, {
    text: "The desk says order 7 shipped on Monday.",
  });
});
