/**
 * #1366 (fence-workers shard) — what a step's frame is made of, each rule on its own: the number of the visit (the one
 * `maxVisits` counts, from 1), the version the execution started on, the step's idempotency key — the same on a replay
 * of the visit — and the facts of its execution (the lease it runs under, where its request came from, its deadlines,
 * its parent when it is a child, the call chain of a root's mesh calls); and the node id a running step is known by.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newRunContext } from "../../src/core/run-context.js";
import { currentFrame } from "../../src/flow/context/frame.js";
import {
  startedVersionOf,
  stepFrameAt,
  stepFrameOf,
  stepNodeIdOf,
  visitNumberOf,
} from "../../src/flow/runtime/step-frame.js";

vi.mock("../../src/flow/context/frame.js", async (original) => ({
  ...(await original<typeof import("../../src/flow/context/frame.js")>()),
  currentFrame: vi.fn(),
}));
vi.mock("../../src/flow/context/runtime-contexts.js", () => ({
  tenantOfExecution: vi.fn((_contexts: unknown, tenant: unknown) => ({ tenant })),
}));

const node = { id: "clerk", kind: "agent", component: "ClerkAgent" } as never;
const workflow = { name: "support", version: "2.0.0", configHash: "h" } as never;
const contexts = { application: { name: "desk" } } as never;
const deps = { workflow, contexts, components: new Map() } as never;

const lease = { scopeKey: "k" };
const stateOf = (changes: Record<string, unknown> = {}, ownContexts: object = {}) =>
  ({
    runId: "run-1",
    start: "chat",
    startedVersion: "",
    visits: {},
    piiKey: undefined,
    contexts: { tenant: { tenantId: "t" }, execution: { v: 1 }, ...ownContexts },
    ...changes,
  }) as never;
const configOf = (run: object = {}) =>
  ({
    configurable: {
      run: {
        ...newRunContext({ runId: "run-1", threadId: "thread-1", ownerId: "owner-1" }),
        observability: "obs",
        correlationKey: "run-key",
        fingerprintKeys: "fp",
        ...run,
      },
    },
  }) as never;

beforeEach(() => {
  vi.mocked(currentFrame).mockReset();
});

describe("#1366: the number of a visit and the version an execution started on", () => {
  it("a visit is the next of the node, from 1", () => {
    expect(visitNumberOf(node, stateOf())).toBe(1);
    expect(visitNumberOf(node, stateOf({ visits: { clerk: 2, other: 7 } }))).toBe(3);
  });

  it("an execution keeps the version it started on, else the workflow's", () => {
    expect(startedVersionOf(stateOf(), workflow)).toBe("2.0.0");
    expect(startedVersionOf(stateOf({ startedVersion: "1.0.0" }), workflow)).toBe("1.0.0");
  });
});

describe("#1366: the frame of one visit of a node", () => {
  it("names the step by its component, node, visit and an idempotency key a replay of the visit has again", () => {
    const state = stateOf({ visits: { clerk: 1 } });

    const first = stepFrameOf(node, state, configOf(), deps);
    const replay = stepFrameOf(node, state, configOf(), deps);

    expect(first.step).toMatchObject({
      nodeId: "clerk",
      visitNumber: 2,
      idempotencyKey: "run-1:clerk:2",
      copyNumber: 1,
      validationAttempts: 0,
    });
    expect(first.step.component).toMatchObject({ type: "ClerkAgent", name: "clerk" });
    expect(replay.step.idempotencyKey).toBe(first.step.idempotencyKey);
    expect(Object.isFrozen(first.step)).toBe(true);
    expect(Object.isFrozen(first.step.component)).toBe(true);
  });

  it("a branch's copy and item are in its node id, its copy number and its key", () => {
    const site = { node, visitNumber: 3, nodeId: "clerk#2", copyNumber: 2, itemIndex: 4 };

    const frame = stepFrameAt(site, stateOf(), configOf(), deps);

    expect(frame.step).toMatchObject({
      nodeId: "clerk#2",
      visitNumber: 3,
      copyNumber: 2,
      itemIndex: 4,
      idempotencyKey: "run-1:clerk#2:3:4",
    });
  });

  it("its execution is the run's: id, thread, owner and signal, the workflow with the version it started on, the tenant and the values", () => {
    const frame = stepFrameOf(node, stateOf({ startedVersion: "1.5.0" }), configOf(), deps);

    expect(frame.execution).toMatchObject({
      executionId: "run-1",
      threadId: "thread-1",
      ownerId: "owner-1",
      workflow: { name: "support", version: "2.0.0", configHash: "h", startedVersion: "1.5.0" },
      tenant: { tenant: { tenantId: "t" } },
      values: { v: 1 },
      observability: "obs",
      correlationKey: "run-key",
      fingerprintKeys: "fp",
    });
    expect(Object.isFrozen(frame.execution)).toBe(true);
    expect(Object.isFrozen(frame.execution.workflow)).toBe(true);
  });

  it("a pass whose workflow has none yet starts on the workflow's version", () => {
    const frame = stepFrameOf(node, stateOf(), configOf(), deps);

    expect(frame.execution.workflow.startedVersion).toBe("2.0.0");
  });

  it("its correlation key is the tree's PII key when it has one, else the run's", () => {
    const withKey = stepFrameOf(node, stateOf({ piiKey: "pii-key" }), configOf(), deps);

    expect(withKey.execution.correlationKey).toBe("pii-key");
  });

  it("runs under the lease of its run, when it has one, and under none otherwise", () => {
    const held = stepFrameOf(node, stateOf(), configOf({ lease }), deps);
    const none = stepFrameOf(node, stateOf(), configOf(), deps);

    expect(held.execution.lease).toBe(lease);
    expect(Object.keys(none.execution)).not.toContain("lease");
  });

  it("carries the observer of the deps, when they have one, and none otherwise", () => {
    const observer = { id: "observer" };

    const observed = stepFrameOf(node, stateOf(), configOf(), { ...(deps as object), observer } as never);
    const bare = stepFrameOf(node, stateOf(), configOf(), deps);

    expect(observed.execution.observer).toBe(observer);
    expect(Object.keys(bare.execution)).not.toContain("observer");
  });

  it("knows where its request came from and its deadlines, when its contexts hold them", () => {
    const own = {
      mesh: { trusted: { origin: { application: "peer" } } },
      deadline: "2030-01-01T00:00:00.000Z",
      quorumDeadlineAt: "2030-01-01T00:10:00.000Z",
    };

    const frame = stepFrameOf(node, stateOf({}, own), configOf(), deps);
    const bare = stepFrameOf(node, stateOf(), configOf(), deps);
    const untrusted = stepFrameOf(node, stateOf({}, { mesh: {} }), configOf(), deps);

    expect(frame.execution).toMatchObject({
      origin: { application: "peer" },
      deadline: "2030-01-01T00:00:00.000Z",
      quorumDeadlineAt: "2030-01-01T00:10:00.000Z",
    });
    for (const none of [bare, untrusted])
      for (const key of ["origin", "deadline", "quorumDeadlineAt"])
        expect(Object.keys(none.execution)).not.toContain(key);
  });

  it("a root carries the call chain its mesh calls extend: what reached it, then its own hop", () => {
    const inbound = {
      chain: [{ application: "caller", start: "ask", executionId: "e0" }],
      traceId: "t1",
    };

    const frame = stepFrameOf(node, stateOf({}, { mesh: inbound }), configOf(), deps);

    expect(frame.execution.mesh).toEqual({
      chain: [
        { application: "caller", start: "ask", executionId: "e0" },
        { application: "desk", start: "chat", executionId: "run-1" },
      ],
      traceId: "t1",
    });
    expect(Object.keys(frame.execution)).not.toContain("parent");
  });

  it("a child carries its parent and its item instead of a chain", () => {
    const tree = { parent: { executionId: "p1" }, itemIndex: 2 };

    const frame = stepFrameOf(node, stateOf(), configOf({ tree }), deps);

    expect(frame.execution).toMatchObject({ parent: { executionId: "p1" }, itemIndex: 2 });
    expect(Object.keys(frame.execution)).not.toContain("mesh");
  });
});

describe("#1366: the node id of the step running now", () => {
  it("is the frame's, for a copy of a launch", () => {
    vi.mocked(currentFrame).mockReturnValue({
      isClosed: () => false,
      step: { nodeId: "clerk#2" },
    } as never);

    expect(stepNodeIdOf(node)).toBe("clerk#2");
  });

  it("is the node's own outside any frame and in one that ended", () => {
    vi.mocked(currentFrame).mockReturnValue(undefined);
    expect(stepNodeIdOf(node)).toBe("clerk");

    vi.mocked(currentFrame).mockReturnValue({
      isClosed: () => true,
      step: { nodeId: "clerk#2" },
    } as never);
    expect(stepNodeIdOf(node)).toBe("clerk");
  });
});
