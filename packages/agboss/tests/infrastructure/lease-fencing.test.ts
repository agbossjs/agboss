/**
 * #335 (S1): local fencing of the execution lease — the holder trusts its lease until
 * `confirmedUntil` (the `Clock` before the last renewal its store confirmed, plus the lease). A
 * store that does not answer past it stops the holder at the lease's end: its signal aborts with
 * `ExecutionLeaseLostError`, the agent's tool loop starts no further call, and another instance
 * recovers the tree. A store error within the lease lets the checkpoint write go on. A tool call's
 * idempotency key is the same when a recovered step replays it.
 */
import { AIMessageChunk } from "@langchain/core/messages";
import { beforeEach, describe, expect, it } from "vitest";
import { ExecutionLeaseLostError, ResumeReason } from "../../src/index.js";
import { idempotencyKeyOf } from "../../src/flow/context/idempotency.js";
import { withCallIds } from "../../src/graph/agent-loop/model-node.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  Clerk,
  ends,
  Hold,
  levers,
  OrderWorkflowStart,
  ReceiptDto,
  RecoveryApplication,
  resetRecovery,
  seen,
  Step,
} from "./fixtures/recovery.workflow.js";

const test = testWith(RecoveryApplication, { instances: 2 });

beforeEach(resetRecovery);

/** The instance `index` of the test (`instances: 2`). */
const instance = (apps: readonly TestApp[], index: number): TestApp => {
  const found = apps[index];
  if (found === undefined) throw new Error(`the test runs no instance ${String(index)}`);
  return found;
};

/** Builds the instances in order (`instance-1`, `instance-2`): each starts its recovery sweep. */
async function ready(apps: readonly TestApp[]): Promise<void> {
  for (const app of apps) await app.ready();
}

/** An execution started on an instance: its call, settled only when it ends. */
interface StartedExecution {
  readonly call: Promise<unknown>;
}

/** Starts an execution on `app` that takes a step and then holds; resolves once it holds. */
async function holding(app: TestApp): Promise<StartedExecution> {
  const held = new Promise<void>((resolve) => {
    levers.holdStarted = resolve;
  });
  const call = execute(app, OrderWorkflowStart, { text: "step, then hold" });
  call.catch(() => undefined);
  await held;
  return { call };
}

/** The model's script of a clerk that steps, holds, then answers. */
const stepHoldAnswer = [
  callTool(Step, { text: "one" }),
  callTool(Hold, { text: "a long job" }),
  replyWith(ReceiptDto, { text: "Done." }),
] as const;

describe("#335 AC1 / AC3: a lease store down past the lease stops the holder at the lease's end", () => {
  test("the tool loop aborts at expiry: no further model or tool call, no onError; the other instance recovers and finishes", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(...stepHoldAnswer);
    await ready(apps);
    const { call: cutOff } = await holding(instance(apps, 0));

    levers.storeDown.add("instance-1");
    await clock.advance(seconds(29));
    expect(seen.holds.map((signal) => signal.aborted)).toEqual([false]);
    await clock.advance(seconds(2));
    const [recovered] = await ends(1);

    await expect(cutOff).rejects.toThrow(ExecutionLeaseLostError);
    await expect(cutOff).rejects.toThrow(/expired before its store confirmed a renewal/);
    expect(seen.holds[0]?.reason).toBeInstanceOf(ExecutionLeaseLostError);
    expect(recovered?.output).toEqual({ text: "Done." });
    // instance-1 made two model calls (step, hold), instance-2 the answer: none after the abort
    expect(mockLlm(Clerk)).toHaveBeenCalledTimes(3);
    expect(seen.steps).toEqual(["one"]);
    expect(seen.holds).toHaveLength(2);
    expect(seen.resumes).toEqual([{ reason: ResumeReason.Recovered, decision: undefined }]);
    expect(seen.errors).toEqual([]);
  });
});

describe("#335 S1: a store error within the lease", () => {
  test("lets the checkpoint writes through: the holder finishes the tree", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(...stepHoldAnswer);
    await ready(apps);
    const { call } = await holding(instance(apps, 0));

    levers.storeDown.add("instance-1");
    await clock.advance(seconds(15));
    levers.letGo?.();

    expect(await call).toMatchObject({ output: { text: "Done." } });
    expect(seen.holds[0]?.reason).not.toBeInstanceOf(ExecutionLeaseLostError);
    expect(seen.errors).toEqual([]);
  });

  test("a renewal that succeeds again before expiry keeps the holder past the first lease", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(...stepHoldAnswer);
    await ready(apps);
    const { call } = await holding(instance(apps, 0));

    levers.storeDown.add("instance-1");
    await clock.advance(seconds(15));
    levers.storeDown.delete("instance-1");
    await clock.advance(seconds(20));
    levers.letGo?.();

    expect(await call).toMatchObject({ output: { text: "Done." } });
    expect(seen.holds[0]?.reason).not.toBeInstanceOf(ExecutionLeaseLostError);
    expect(seen.resumes).toEqual([]);
    expect(seen.leases).toHaveLength(1);
  });
});

describe("#335 AC2: tool-call idempotency keys", () => {
  test("a recovered step calls the interrupted tool with the same key", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(...stepHoldAnswer);
    await ready(apps);
    const { call: cutOff } = await holding(instance(apps, 0));

    levers.storeDown.add("instance-1");
    await clock.advance(seconds(31));
    await ends(1);

    await expect(cutOff).rejects.toThrow(ExecutionLeaseLostError);
    const [interrupted, replayed] = seen.holdKeys;
    expect(seen.holdKeys).toHaveLength(2);
    expect(replayed).toBe(interrupted);
  });

  it("two calls with one provider id in a move get distinct ids and keys, the same on a replay", () => {
    const response = new AIMessageChunk({
      content: "",
      tool_calls: [
        { id: "call_0", name: "step", args: { text: "a" } },
        { id: "call_0", name: "step", args: { text: "b" } },
        { id: "call_1", name: "hold", args: { text: "c" } },
        { id: "", name: "hold", args: { text: "d" } },
      ],
    });
    const state = {
      runId: "exec-1",
      flowPath: ["order-workflow-start", "clerk-agent"],
      modelCalls: 0,
    };

    const move = withCallIds(response, state);
    const ids = (move.tool_calls ?? []).map((call) => call.id);
    const keys = ids.map((callId) =>
      idempotencyKeyOf({ executionId: "exec-1", nodeId: "clerk-agent", visitNumber: 1, callId }),
    );

    expect(ids).toEqual(["call_0:0", "call_0:1", "call_1", "exec-1:2:1:3"]);
    expect(new Set(keys).size).toBe(4);
    expect((withCallIds(response, state).tool_calls ?? []).map((call) => call.id)).toEqual(ids);
  });
});
