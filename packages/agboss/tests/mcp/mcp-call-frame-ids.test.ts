/**
 * #1366: the ids of an MCP call's frame — the client's `callId` is the call's, and the execution id follows it, so a
 * client that repeats a call with the same `callId` gets the same step idempotency key (and a fenced effect under it
 * runs once); a call without one gets an id of its own each time.
 */
import { describe, expect, it } from "vitest";
import { rememberAppWorkflow } from "../../src/app/app-workflow.js";
import { currentFrame } from "../../src/flow/context/frame.js";
import { inMcpCallFrame } from "../../src/mcp/mcp-call-frame.js";

const app = {} as never;
rememberAppWorkflow(app, {
  workflow: { name: "desk", version: "1.0.0", configHash: "h" },
  tenant: { tenantId: "default", application: { name: "desk-app" } },
} as never);

const tool = { app, type: Object, name: "pay" };

/** The ids a call's frame holds, as its work reads them. */
const idsOf = (callId: string | undefined) =>
  inMcpCallFrame(tool, { callId, signal: new AbortController().signal } as never, () =>
    Promise.resolve({
      executionId: currentFrame()?.execution.executionId,
      callId: currentFrame()?.step.callId,
      key: currentFrame()?.step.idempotencyKey,
    }),
  );

describe("#1366: the frame of an MCP call", () => {
  it("takes the client's call id and names the execution after it, the same key for a repeat", async () => {
    const first = await idsOf("c-1");
    const again = await idsOf("c-1");
    const other = await idsOf("c-2");

    expect(first).toMatchObject({ executionId: "mcp_c-1", callId: "c-1" });
    expect(again).toEqual(first);
    expect(other.key).not.toBe(first.key);
  });

  it("makes an id of its own for a call without one, new each time", async () => {
    const first = await idsOf(undefined);
    const second = await idsOf(undefined);

    expect(first.callId).toMatch(/^mcp_pay_/u);
    expect(first.executionId).toBe(`mcp_${first.callId ?? ""}`);
    expect(second.callId).not.toBe(first.callId);
  });
});
