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
  contextsOf: (given: { tenant?: { tenantId?: string } }) => ({
    tenant: { tenantId: given.tenant?.tenantId ?? "default", application: { name: "desk-app" } },
    execution: {},
  }),
} as never);

const tool = { app, type: Object, name: "pay" };

/** The ids a call's frame holds, as its work reads them. */
const idsOf = (callId: string | undefined, session: object = {}) =>
  inMcpCallFrame(tool, { callId, session, signal: new AbortController().signal } as never, () =>
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

    expect(first).toMatchObject({ callId: "c-1" });
    expect(first.executionId).toMatch(/^mcp_[0-9a-f]{32}$/u);
    expect(again).toEqual(first);
    expect(other.key).not.toBe(first.key);
  });

  it("makes an id of its own for a call without one, new each time", async () => {
    const first = await idsOf(undefined);
    const second = await idsOf(undefined);

    expect(first.callId).toMatch(/^mcp_pay_/u);
    expect(first.executionId).toMatch(/^mcp_[0-9a-f]{32}$/u);
    expect(second.callId).not.toBe(first.callId);
  });

  it("gives two tenants, and two owners, the same callId different keys", async () => {
    const acme = await idsOf("c-1", { tenant: { tenantId: "acme" }, ownerId: "dana" });
    const globex = await idsOf("c-1", { tenant: { tenantId: "globex" }, ownerId: "dana" });
    const eve = await idsOf("c-1", { tenant: { tenantId: "acme" }, ownerId: "eve" });
    const again = await idsOf("c-1", { tenant: { tenantId: "acme" }, ownerId: "dana" });

    expect(new Set([acme.key, globex.key, eve.key]).size).toBe(3);
    expect(new Set([acme.executionId, globex.executionId, eve.executionId]).size).toBe(3);
    expect(again.key).toBe(acme.key);
  });

  it("keeps an owner and a peer of the same name apart", async () => {
    const owner = await idsOf("c-1", { ownerId: "x" });
    const peer = await idsOf("c-1", { peer: "x" });

    expect(owner.key).not.toBe(peer.key);
    expect(owner.executionId).not.toBe(peer.executionId);
  });
});
