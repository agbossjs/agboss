/**
 * #1366: what an admitted request hands its execution from a trusted peer's envelope — the origin as the
 * receiver verified it, the caller's budget left and the time the caller still waits — and nothing of what
 * the envelope does not say or says unreadably.
 */
import { describe, expect, it } from "vitest";
import { inboundMeshOfRequest } from "../../../src/mesh/mesh-admission.js";
import type { MeshEnvelope } from "../../../src/mesh/mesh-envelope.js";

const envelope = (more: Partial<MeshEnvelope> = {}): MeshEnvelope => ({
  schema: 1,
  issuer: "orders-application",
  origin: {
    rootExecutionId: "r-1",
    executionId: "e-1",
    parentExecutionId: "r-1",
    workflow: { name: "orders-workflow", version: "1.4.0" },
    step: { component: "support-agent", idempotencyKey: "e-1:support-agent:1:call_7" },
  },
  callChain: [
    { application: "orders-application", start: "orders-workflow-start", executionId: "r-1" },
    { application: "gateway-application", start: "gateway-start", executionId: "g-1" },
  ],
  ...more,
});

describe("#1366: what a trusted peer's envelope hands the execution", () => {
  it("the budget and the time the caller has left, in dollars and milliseconds, and the origin with the verified peer and its hops", () => {
    const inbound = inboundMeshOfRequest(
      envelope({
        budget: { remaining: "0.42", currency: "USD" },
        deadline: { remaining: "PT58.2S" },
      }),
      undefined,
      "gateway-application",
    );

    expect(inbound?.trusted).toEqual({
      origin: { ...envelope().origin, application: "gateway-application", hops: 2 },
      budget: 0.42,
      deadline: 58_200,
    });
  });

  it("a claim the envelope does not make, or makes unreadably, is no limit of the callee", () => {
    const bare = inboundMeshOfRequest(envelope(), undefined, "gateway-application");
    const unreadable = inboundMeshOfRequest(
      envelope({ budget: { remaining: "-1", currency: "USD" }, deadline: { remaining: "soon" } }),
      undefined,
      "gateway-application",
    );

    expect(bare?.trusted).toEqual({
      origin: { ...envelope().origin, application: "gateway-application", hops: 2 },
    });
    expect(unreadable?.trusted).toEqual(bare?.trusted);
  });

  it("an envelope no verified peer issued is trusted for nothing: its chain only", () => {
    const inbound = inboundMeshOfRequest(
      envelope({ budget: { remaining: "0.42", currency: "USD" }, deadline: { remaining: "PT5S" } }),
      undefined,
    );

    expect(inbound).toEqual({ chain: envelope().callChain });
  });
});
