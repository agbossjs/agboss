import { expect } from "vitest";
import { callTool, replyWith, testWith } from "@agboss/core/testing";
import { DeskA2aCallerResolver } from "../../../src/desk/a2a/desk.a2a-caller-resolver.js";
import { DeskA2AExpose } from "../../../src/desk/a2a/desk.a2a-expose.js";
import { DeskAgent } from "../../../src/desk/agents/desk/desk.agent.js";
import { OrderStatusTool } from "../../../src/desk/tools/order-status.tool.js";
import { DeskApplication } from "../../../src/desk.application.js";

/**
 * The desk served over A2A v1.0 (#387, #398, #808): `desk-application` serves its start as the one
 * skill of its Agent Card, on the loopback by the `a2aServer` fixture; any A2A client calls it with
 * JSON-RPC — here a plain `fetch`. The helpline's side of the contract is in
 * tests/helpline/workflows/helpline/helpline.workflow.test.ts; `npm run check` compares the
 * contract with the desk's `describe --json` (`check --federation`).
 */

const deskTest = testWith(DeskApplication);
const desk = { expose: DeskA2AExpose, callerResolver: DeskA2aCallerResolver };

/** A JSON-RPC `SendMessage` of one data part, as the helpline's tenant (none: no header). */
async function sendMessage(url: string, tenantId?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "a2a-version": "1.0",
      ...(tenantId === undefined ? {} : { "x-tenant-id": tenantId }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "SendMessage",
      params: {
        message: {
          messageId: "helpline-1",
          role: "ROLE_USER",
          parts: [
            {
              data: { customerId: "c-1", question: "Where is #7?" },
              mediaType: "application/json",
            },
          ],
        },
      },
    }),
  });
}

deskTest("the desk's Agent Card names its one skill", async ({ a2aServer }) => {
  const { url } = await a2aServer(desk);

  const card = (await (await fetch(`${url}/.well-known/agent-card.json`)).json()) as {
    readonly skills: readonly { readonly id: string }[];
  };

  expect(card.skills.map((skill) => skill.id)).toEqual(["desk-workflow-start"]);
});

deskTest(
  "the desk answers an A2A task with its finish's output",
  async ({ a2aServer, mockLlm }) => {
    mockLlm(DeskAgent).thenReturn(
      callTool(OrderStatusTool, { orderId: "7" }),
      replyWith("Order 7 shipped on Monday."),
    );
    const { url } = await a2aServer(desk);

    const answer = (await (await sendMessage(url, "helpline")).json()) as {
      readonly result: { readonly task: unknown };
    };

    expect(answer.result.task).toMatchObject({
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [{ parts: [{ text: "Order 7 shipped on Monday.", mediaType: "text/plain" }] }],
    });
  },
);

deskTest(
  "a caller naming no tenant is refused, and nothing runs",
  async ({ a2aServer, mockLlm }) => {
    const { url } = await a2aServer(desk);

    const refused = await sendMessage(url);

    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({
      code: "a2a.caller-unauthenticated",
      error: "no x-tenant-id header",
    });
    expect(mockLlm(DeskAgent)).toHaveBeenCalledTimes(0);
  },
);
