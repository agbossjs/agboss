import { describe, expect, it } from "vitest";
import { applicationOf, type AssembledApplication } from "../../src/application/assemble.js";
import { Application } from "../../src/application/application.js";
import {
  EmptyEnvironment,
  HopsLimitExceededError,
  LimitExceededError,
  MeshLoopDetectedError,
} from "../../src/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { meshAppOf } from "../a2a/fixtures/mesh.workflow.js";
import { meshRefusalOf, inboundMeshOfRequest } from "../../src/mesh/mesh-admission.js";
import { encodeMeshEnvelope, meshEnvelopeOf } from "../../src/mesh/mesh-envelope-codec.js";
import type { MeshEnvelope } from "../../src/mesh/mesh-envelope.js";
import { meshLimitBodyOf, meshLimitErrorOf } from "../../src/mesh/mesh-wire.js";
import { traceIdOf } from "../../src/mesh/outbound-mesh.js";

const envelope: MeshEnvelope = {
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
};

const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("#398 PR 1: the envelope on the wire is an unsecured JWS", () => {
  it("encodes and reads back the same envelope", () => {
    const text = encodeMeshEnvelope(envelope);

    expect(text).toMatch(/^[\w-]+\.[\w-]+\.$/);
    expect(meshEnvelopeOf(text)).toEqual(envelope);
  });

  it.each([
    ["not a string", 42],
    ["two parts", `${part({ alg: "none" })}.${part(envelope)}`],
    [
      "a signature (PR 2 reads it, PR 1 does not)",
      `${part({ alg: "none" })}.${part(envelope)}.c2ln`,
    ],
    ["another alg", `${part({ alg: "EdDSA" })}.${part(envelope)}.`],
    ["not JSON", `${part({ alg: "none" })}.%%%.`],
    ["another schema", `${part({ alg: "none" })}.${part({ ...envelope, schema: 2 })}.`],
    [
      "a hop without its id",
      `${part({ alg: "none" })}.${part({ ...envelope, callChain: [{ application: "a" }] })}.`,
    ],
    ["too long", "x".repeat(20_000)],
  ])("anything else is no envelope: %s", (_case, value) => {
    expect(meshEnvelopeOf(value)).toBeUndefined();
  });
});

describe("#398 PR 1: the receiver's check of the call chain", () => {
  const receiver = {
    entry: { application: "orders-application", start: "orders-workflow-start" },
    maxMeshHops: 3,
  };

  it("its own (application, start) in the chain is a loop; another start of it is not", () => {
    const other = { ...receiver, entry: { ...receiver.entry, start: "refunds-workflow-start" } };

    expect(meshRefusalOf(receiver, envelope)).toBeInstanceOf(MeshLoopDetectedError);
    expect(meshRefusalOf(other, envelope)).toBeUndefined();
    expect(meshRefusalOf(receiver, undefined)).toBeUndefined();
  });

  it("a chain as long as maxMeshHops is refused, one shorter runs", () => {
    const hop = (index: number) => ({
      application: `a${String(index)}-application`,
      start: "s",
      executionId: "x",
    });
    const billing = { ...receiver, entry: { application: "billing-application", start: "b" } };

    const refused = meshRefusalOf(billing, { ...envelope, callChain: [hop(1), hop(2), hop(3)] });

    expect(refused).toMatchObject({
      code: "limit.hops",
      maxMeshHops: 3,
      hops: 4,
      key: "maxMeshHops",
    });
    expect(refused).toBeInstanceOf(LimitExceededError);
    expect(meshRefusalOf(billing, { ...envelope, callChain: [hop(1), hop(2)] })).toBeUndefined();
  });

  it("a valid traceparent's trace id is continued; an invalid one is not", () => {
    const trace = "0af7651916cd43dd8448eb211c80319c";

    expect(inboundMeshOfRequest(undefined, `00-${trace}-b7ad6b7169203331-01`)).toEqual({
      chain: [],
      traceId: trace,
    });
    expect(inboundMeshOfRequest(envelope, "garbage")).toEqual({ chain: envelope.callChain });
    expect(inboundMeshOfRequest(undefined, undefined)).toBeUndefined();
    expect(traceIdOf(`00-${"0".repeat(32)}-b7ad6b7169203331-01`)).toBeUndefined();
  });
});

describe("#398 PR 1: a mesh limit on the wire", () => {
  it("round-trips both limits with their facts; other errors carry none", () => {
    const entry = { application: "billing-application", start: "billing-workflow-start" };
    const loop = new MeshLoopDetectedError(entry, envelope.callChain);
    const hops = new HopsLimitExceededError(entry, envelope.callChain, 1);

    expect(meshLimitErrorOf(meshLimitBodyOf(loop))).toMatchObject({
      entry,
      chain: envelope.callChain,
    });
    expect(meshLimitErrorOf(meshLimitBodyOf(hops))).toMatchObject({ maxMeshHops: 1, hops: 2 });
    expect(meshLimitBodyOf(new Error("other"))).toBeUndefined();
    expect(meshLimitErrorOf({ code: "limit.budget", details: {} })).toBeUndefined();
  });
});

describe("#398 PR 1: @Application({ maxMeshHops })", () => {
  const parts = meshAppOf({ name: "hops", peerUrl: "http://unused" });

  const withHops = (maxMeshHops: number): Promise<AssembledApplication> => {
    @Application({
      name: "hops-invalid-application",
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [parts.MeshWorkflow],
      budgets: TEST_BUDGETS,
      maxMeshHops,
    })
    class HopsApplication {}
    return applicationOf(HopsApplication);
  };

  it.each([0, -1, 2.5])("maxMeshHops %s fails assembly", async (value) => {
    await expect(withHops(value)).rejects.toThrow(
      `[limits.max-mesh-hops-invalid] its maxMeshHops is ${String(value)}, not a whole number of applications from 1`,
    );
  });

  it("is kept as set, else 8", async () => {
    expect((await withHops(3)).maxMeshHops).toBe(3);
    expect((await applicationOf(parts.MeshApplication)).maxMeshHops).toBe(8);
  });
});
