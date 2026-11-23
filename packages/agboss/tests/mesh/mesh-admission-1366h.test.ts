/**
 * #1366: a request's admission and what it hands the execution — a loop is a hop of the same application AND
 * start (one alone is no loop), no envelope is no refusal, and a claim the request does not make leaves its
 * key ABSENT in what the execution keeps (not present as undefined).
 */
import { describe, expect, it } from "vitest";
import { inboundMeshOfRequest, meshRefusalOf } from "../../src/mesh/mesh-admission.js";
import { MeshLoopDetectedError } from "../../src/mesh/mesh-errors.js";
import type { MeshEnvelope } from "../../src/mesh/mesh-envelope.js";

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
  ],
  ...more,
});

const receiver = (application: string, start: string) => ({
  entry: { application, start },
  maxMeshHops: 10,
});

describe("#1366: the admission of a request's call chain", () => {
  it("no envelope: nothing refuses the request", () => {
    expect(meshRefusalOf(receiver("orders-application", "orders-workflow-start"), undefined)).toBe(
      undefined,
    );
  });

  it("the same start in another application is no loop; the same application with another start is none either", () => {
    expect(
      meshRefusalOf(receiver("billing-application", "orders-workflow-start"), envelope()),
    ).toBeUndefined();
    expect(
      meshRefusalOf(receiver("orders-application", "billing-workflow-start"), envelope()),
    ).toBeUndefined();
    expect(
      meshRefusalOf(receiver("orders-application", "orders-workflow-start"), envelope()),
    ).toBeInstanceOf(MeshLoopDetectedError);
  });
});

describe("#1366: a claim the request does not make is an absent key", () => {
  const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

  it("an envelope without a trace id: the chain only, no traceId key and no trusted key", () => {
    expect(inboundMeshOfRequest(envelope(), undefined)).toStrictEqual({
      chain: envelope().callChain,
    });
  });

  it("a trace id without an envelope: the empty chain and the trace id, no trusted key", () => {
    expect(inboundMeshOfRequest(undefined, traceparent, "orders-application")).toStrictEqual({
      chain: [],
      traceId: "0af7651916cd43dd8448eb211c80319c",
    });
  });

  it("a trusted envelope without a budget or a deadline: no budget key and no deadline key", () => {
    const inbound = inboundMeshOfRequest(envelope(), undefined, "orders-application");
    expect(inbound?.trusted).toStrictEqual({
      origin: { ...envelope().origin, application: "orders-application", hops: 1 },
    });
  });

  it("only a budget: a budget and no deadline key; only a deadline: the reverse", () => {
    const withBudget = inboundMeshOfRequest(
      envelope({ budget: { remaining: "0.5", currency: "USD" } }),
      undefined,
      "orders-application",
    );
    const withDeadline = inboundMeshOfRequest(
      envelope({ deadline: { remaining: "PT2S" } }),
      undefined,
      "orders-application",
    );
    expect(Object.keys(withBudget?.trusted ?? {})).toStrictEqual(["origin", "budget"]);
    expect(Object.keys(withDeadline?.trusted ?? {})).toStrictEqual(["origin", "deadline"]);
  });
});
