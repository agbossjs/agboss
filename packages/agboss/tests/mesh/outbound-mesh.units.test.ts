/**
 * #1366 (shard once-mesh) — what a call made inside an execution carries across the mesh, each rule on
 * its own: the envelope's identity of the call (its step's idempotency key, which the receiver's
 * deduplication keys on), its claims of what the caller has left, when it is signed, and the trace.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runInFrame, type FrameSpec } from "../../src/flow/context/frame.js";
import {
  bodyHashOf,
  currentCallChainOf,
  outboundMeshOf,
  outboundMeshOfHash,
  traceIdOf,
  type OutboundMesh,
} from "../../src/mesh/outbound-mesh.js";
import { readMeshEnvelope } from "../../src/mesh/mesh-envelope-codec.js";
import type { MeshEnvelope } from "../../src/mesh/mesh-envelope.js";
import { rememberContextMeshSettings } from "../../src/mesh/mesh-settings.js";
import { VirtualClock } from "../../src/testing/index.js";
import { testFrame } from "../helpers/frame.js";

/** The envelopes handed to the encoder: the JSON of the wire drops a key set to `undefined`, this does not. */
const encoded = vi.hoisted(() => ({ envelopes: [] as unknown[] }));

vi.mock("../../src/mesh/mesh-envelope-codec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/mesh/mesh-envelope-codec.js")>();
  return {
    ...actual,
    encodeMeshEnvelope: (envelope: unknown, key?: unknown) => {
      encoded.envelopes.push(envelope);
      return actual.encodeMeshEnvelope(envelope as never, key as never);
    },
  };
});

const NOW = new Date("2026-11-20T10:00:00.000Z");
const CHAIN = [
  { application: "caller-app", start: "a-start", executionId: "root-1" },
  { application: "middle-app", start: "b-start", executionId: "mid-1" },
];
const TRACE = "0af7651916cd43dd8448eb211c80319c";
const BODY_HASH = "sha256:abc";
const { privateKey } = generateKeyPairSync("ed25519");

const sha = (text: string, length: number) =>
  createHash("sha256").update(text).digest("hex").slice(0, length);

interface Setup {
  readonly mesh?: { chain: typeof CHAIN; traceId?: string } | undefined;
  readonly settings?: boolean;
  readonly signs?: boolean;
  readonly services?: FrameSpec["services"];
  readonly deadlineAt?: string;
  readonly parent?: boolean;
}

/** The frame of a step whose tree has a call chain, with what `setup` changes. */
function frameOf(setup: Setup = {}): FrameSpec {
  const base = testFrame();
  const { application } = base.execution.tenant;
  if (setup.settings !== false)
    rememberContextMeshSettings(application, {
      clock: new VirtualClock(NOW),
      keys: { signingKey: setup.signs === false ? undefined : privateKey, peers: new Map() },
      peers: new Map(),
      envelopeTtl: 60_000,
    } as never);
  const root = {
    ...base.execution,
    executionId: "root-exec",
    mesh: "mesh" in setup ? setup.mesh : { chain: CHAIN, traceId: TRACE },
    ...(setup.deadlineAt === undefined ? {} : { deadline: { at: setup.deadlineAt, deadline: 1 } }),
  } as FrameSpec["execution"];
  const execution =
    setup.parent === true
      ? ({
          ...root,
          executionId: "child-exec",
          mesh: undefined,
          parent: { execution: root, step: base.step },
        } as FrameSpec["execution"])
      : root;
  return {
    ...base,
    execution,
    ...(setup.services === undefined ? {} : { services: setup.services }),
  };
}

const outboundIn = (frame: FrameSpec, audience?: string): Promise<OutboundMesh | undefined> =>
  runInFrame(frame, () => Promise.resolve(outboundMeshOfHash(BODY_HASH, audience)));

describe("#1366: the body hash a call carries", () => {
  it("is sha256: and the hex digest of the body as sent", () => {
    expect(bodyHashOf("hello")).toBe(`sha256:${sha("hello", 64)}`);
    expect(bodyHashOf("")).toBe(`sha256:${sha("", 64)}`);
  });

  it("outboundMeshOf hashes its body and carries the hash", async () => {
    const frame = frameOf();
    const sent = await runInFrame(frame, () => Promise.resolve(outboundMeshOf("the body")));

    expect(sent?.bodyHash).toBe(bodyHashOf("the body"));
    expect(readMeshEnvelope(sent?.envelope)?.envelope.bodyHash).toBe(bodyHashOf("the body"));
  });
});

describe("#1366: a call carries nothing without a frame of a tree with a call chain", () => {
  it("outside any frame", () => {
    expect(outboundMeshOfHash(BODY_HASH)).toBeUndefined();
    expect(outboundMeshOf("body")).toBeUndefined();
    expect(currentCallChainOf()).toBeUndefined();
  });

  it("in a frame whose tree has no call chain", async () => {
    const frame = frameOf({ mesh: undefined });

    expect(await outboundIn(frame)).toBeUndefined();
    await runInFrame(frame, () => {
      expect(currentCallChainOf()).toBeUndefined();
      return Promise.resolve();
    });
  });

  it("in a frame that is closed: its step ended", async () => {
    const frame = frameOf();
    // read after `work` settled, from a timer that kept the frame as its async context
    const [sent, chain] = await new Promise<readonly [OutboundMesh | undefined, unknown]>(
      (resolve) => {
        void runInFrame(frame, () => {
          setTimeout(() => {
            resolve([outboundMeshOfHash(BODY_HASH), currentCallChainOf()]);
          }, 20);
          return Promise.resolve();
        });
      },
    );

    expect(sent).toBeUndefined();
    expect(chain).toBeUndefined();
  });
});

describe("#1366: the envelope's identity of the call", () => {
  it("names the caller, where it was made and the chain it passed through", async () => {
    const frame = frameOf();
    const sent = await outboundIn(frame);
    const envelope = readMeshEnvelope(sent?.envelope)?.envelope;

    expect(envelope).toEqual({
      schema: 1,
      issuer: frame.execution.tenant.application.name,
      origin: {
        rootExecutionId: "root-exec",
        executionId: "root-exec",
        workflow: {
          name: frame.execution.workflow.name,
          version: frame.execution.workflow.version,
        },
        step: {
          component: frame.step.component.name,
          idempotencyKey: frame.step.idempotencyKey,
        },
      },
      callChain: CHAIN,
      issuedAt: NOW.toISOString(),
      expiresIn: "PT60S",
      bodyHash: BODY_HASH,
    });
    expect(sent?.bodyHash).toBe(BODY_HASH);
    expect(sent?.idempotencyKey).toBe(frame.step.idempotencyKey);
  });

  it("a child's call names its own execution, its root and its parent", async () => {
    const sent = await outboundIn(frameOf({ parent: true }));
    const origin = readMeshEnvelope(sent?.envelope)?.envelope.origin;

    expect(origin).toMatchObject({
      rootExecutionId: "root-exec",
      executionId: "child-exec",
      parentExecutionId: "root-exec",
    });
  });

  it("a tool call names its tool", async () => {
    const services = {
      meshCall: {
        tool: "lookup",
        remainingBudget: () => undefined,
        deadlineAt: new Date(NOW.getTime() + 5000),
        recordRemote: () => undefined,
      },
    };
    const sent = await outboundIn(frameOf({ services }));

    expect(readMeshEnvelope(sent?.envelope)?.envelope.origin.step.tool).toBe("lookup");
  });

  it("without settings the call is dated at the epoch, and signs nothing", async () => {
    const sent = await outboundIn(frameOf({ settings: false }), "peer-app");
    const read = readMeshEnvelope(sent?.envelope);

    expect(read?.envelope.issuedAt).toBe("1970-01-01T00:00:00.000Z");
    expect(read?.signed).toBeUndefined();
  });

  it("the call chain of the frame's tree is the one its root keeps", async () => {
    const chain = await runInFrame(frameOf({ parent: false }), () =>
      Promise.resolve(currentCallChainOf()),
    );
    const ofChild = await runInFrame(
      { ...frameOf({ parent: true }), execution: frameOf({ parent: true }).execution },
      () => Promise.resolve(currentCallChainOf()),
    );

    expect(chain).toEqual(CHAIN);
    expect(ofChild).toEqual(CHAIN);
  });
});

describe("#1366: who an envelope is addressed to, and when it is signed", () => {
  it("an envelope with no audience is an unsigned claim, even with a signing key", async () => {
    const read = readMeshEnvelope((await outboundIn(frameOf()))?.envelope);

    expect(read?.envelope).not.toHaveProperty("audience");
    expect(read?.signed).toBeUndefined();
  });

  it("an addressed envelope carries its audience and is signed with the key", async () => {
    const read = readMeshEnvelope((await outboundIn(frameOf(), "peer-app"))?.envelope);

    expect(read?.envelope.audience).toBe("peer-app");
    expect(read?.signed).toBeDefined();
  });

  it("an addressed envelope of an application with no signing key is unsigned", async () => {
    const read = readMeshEnvelope(
      (await outboundIn(frameOf({ signs: false }), "peer-app"))?.envelope,
    );

    expect(read?.envelope.audience).toBe("peer-app");
    expect(read?.signed).toBeUndefined();
  });
});

describe("#1366: what the envelope claims of the calling execution", () => {
  const call = (remaining: number | undefined, deadlineMs: number) => ({
    tool: "lookup",
    remainingBudget: () => remaining,
    deadlineAt: new Date(NOW.getTime() + deadlineMs),
    recordRemote: () => undefined,
  });
  const claimsOf = async (setup: Setup) => {
    const envelope = readMeshEnvelope((await outboundIn(frameOf(setup)))?.envelope)?.envelope;
    return { budget: envelope?.budget, deadline: envelope?.deadline };
  };

  it("a tool call claims its own budget and deadline", async () => {
    expect(
      await claimsOf({
        services: { meshCall: call(0.42, 58_200), remainingBudget: () => 99 },
        deadlineAt: "2026-11-20T10:30:00.000Z",
      }),
    ).toEqual({
      budget: { remaining: "0.42", currency: "USD" },
      deadline: { remaining: "PT58.2S" },
    });
  });

  it("a tool call whose execution has no budget claims none, though the step's own would", async () => {
    expect(
      await claimsOf({ services: { meshCall: call(undefined, 1000), remainingBudget: () => 5 } }),
    ).toEqual({ budget: undefined, deadline: { remaining: "PT1S" } });
  });

  it("a step's own call claims what the execution may still spend, and the execution's deadline", async () => {
    expect(
      await claimsOf({
        services: { remainingBudget: () => 1.5 },
        deadlineAt: "2026-11-20T10:00:30.000Z",
      }),
    ).toEqual({
      budget: { remaining: "1.5", currency: "USD" },
      deadline: { remaining: "PT30S" },
    });
  });

  it("claims nothing of a budget no one sets, nor of a deadline no one sets", async () => {
    expect(await claimsOf({})).toEqual({ budget: undefined, deadline: undefined });
    expect(await claimsOf({ services: { remainingBudget: () => undefined } })).toEqual({
      budget: undefined,
      deadline: undefined,
    });
  });

  it("claims a budget of 0 left, and a deadline already passed as no time", async () => {
    expect(
      await claimsOf({
        services: { remainingBudget: () => 0 },
        deadlineAt: "2026-11-20T09:59:00.000Z",
      }),
    ).toEqual({
      budget: { remaining: "0", currency: "USD" },
      deadline: { remaining: "PT0S" },
    });
  });

  it("claims no deadline when the execution's is no date", async () => {
    expect((await claimsOf({ deadlineAt: "not a date" })).deadline).toBeUndefined();
  });
});

describe("#1366: the trace a call continues", () => {
  const traceOf = (sent: OutboundMesh | undefined) =>
    /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/.exec(sent?.traceparent ?? "");

  it("continues the caller's trace id; its span is made of the step's idempotency key", async () => {
    const frame = frameOf();
    const match = traceOf(await outboundIn(frame));

    expect(match?.[1]).toBe(TRACE);
    expect(match?.[2]).toBe(sha(frame.step.idempotencyKey, 16));
  });

  it("makes a trace id of the root execution when the caller sent none", async () => {
    const match = traceOf(await outboundIn(frameOf({ mesh: { chain: CHAIN } })));

    expect(match?.[1]).toBe(sha("root-exec", 32));
  });
});

describe("#1366: the trace id of a traceparent", () => {
  it("is the id of a version 00 traceparent, spaces around it dropped", () => {
    expect(traceIdOf(`00-${TRACE}-b7ad6b7169203331-01`)).toBe(TRACE);
    expect(traceIdOf(`  00-${TRACE}-b7ad6b7169203331-00 \n`)).toBe(TRACE);
  });

  it("is none for a value that is no traceparent of version 00", () => {
    expect(traceIdOf(undefined)).toBeUndefined();
    expect(traceIdOf(5)).toBeUndefined();
    expect(traceIdOf("")).toBeUndefined();
    expect(traceIdOf(`01-${TRACE}-b7ad6b7169203331-01`)).toBeUndefined();
    expect(traceIdOf(`00-${TRACE.toUpperCase()}-b7ad6b7169203331-01`)).toBeUndefined();
    expect(traceIdOf(`00-${TRACE.slice(1)}-b7ad6b7169203331-01`)).toBeUndefined();
    expect(traceIdOf(`00-${TRACE}-b7ad6b716920333-01`)).toBeUndefined();
    expect(traceIdOf(`00-${TRACE}-b7ad6b7169203331-1`)).toBeUndefined();
    expect(traceIdOf(`x00-${TRACE}-b7ad6b7169203331-01`)).toBeUndefined();
    expect(traceIdOf(`00-${TRACE}-b7ad6b7169203331-01x`)).toBeUndefined();
  });

  it("is none for the all-zero trace id", () => {
    expect(traceIdOf(`00-${"0".repeat(32)}-b7ad6b7169203331-01`)).toBeUndefined();
  });
});

describe("#1366: the envelope has the keys it has a value for, and no other", () => {
  const lastEnvelope = () => encoded.envelopes.at(-1) as MeshEnvelope;

  it("a root's call without a tool or an audience has neither key, nor a parent", async () => {
    await outboundIn(frameOf());

    const envelope = lastEnvelope();
    expect(Object.keys(envelope).toSorted()).toEqual(
      ["bodyHash", "callChain", "expiresIn", "issuedAt", "issuer", "origin", "schema"].toSorted(),
    );
    expect(Object.keys(envelope.origin).toSorted()).toEqual(
      ["executionId", "rootExecutionId", "step", "workflow"].toSorted(),
    );
    expect(Object.keys(envelope.origin.step).toSorted()).toEqual(["component", "idempotencyKey"]);
  });

  it("a child's tool call has its parent and its tool, and an addressed one its audience", async () => {
    const meshCall = {
      tool: "lookup",
      remainingBudget: () => 1,
      deadlineAt: new Date(NOW.getTime() + 1000),
      recordRemote: () => undefined,
    };
    await outboundIn(frameOf({ parent: true, services: { meshCall } }), "peer-app");

    const envelope = lastEnvelope();
    expect(envelope.audience).toBe("peer-app");
    expect(Object.keys(envelope.origin)).toContain("parentExecutionId");
    expect(Object.keys(envelope.origin.step)).toContain("tool");
  });
});
