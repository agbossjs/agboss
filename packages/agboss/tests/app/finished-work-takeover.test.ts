/**
 * #520 — the sibling paths of a stale claim of finished work: the recovery sweep of a frozen
 * instance that listed a root still `running`, then took its lease once the tree had finished
 * elsewhere, records no takeover and holds nothing; a child that rests at a pause gives its lease
 * back as before (released, not finished), so its resume runs it again, and only its end finishes
 * it.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionRecordStatus, ExecutionStatus } from "../../src/index.js";
import { callTool, replyWith, testWith, type ModelRequest } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { resetLogged } from "../helpers/log.js";
import { until } from "../helpers/until.js";
import { settle } from "./fixtures/fence-takeover.js";
import {
  bothReady,
  childOf,
  item,
  leaseRowOf,
  statusOf,
  takeoversOf,
} from "./fixtures/finished-work.js";
import { ItemResultDto } from "../flow/runtime/fixtures/fan-out.workflow.js";
import {
  ConfirmItemTool,
  openGate,
  RemoteChildYieldApplication,
  resetYield,
  YieldCheckedWorkflowFinish,
  YieldCheckWorkflowStart,
  YieldReviewerAgent,
  YieldReviewsWorkflowStart,
  yieldSeen,
} from "./fixtures/remote-child-yield.workflow.js";

const test = testWith(RemoteChildYieldApplication, { instances: 2 });

/** The reviewer: confirms an `ask…` item first, then answers it. */
const reviewer = (request: ModelRequest) => {
  const isConfirmed =
    request.kind === "chat" && request.messages.some((line) => line.role === "tool");
  return isConfirmed
    ? replyWith(ItemResultDto, { name: "ask" })
    : callTool(ConfirmItemTool, { name: "ask" });
};

beforeEach(() => {
  resetYield();
  resetLogged();
});

describe("#520: the recovery sweep of a frozen instance and a finished root", () => {
  test("a sweep that listed a running root and took its lease after the tree finished records no takeover and keeps no lease", async ({
    apps,
    clock,
    leases,
  }) => {
    const [a, b] = await bothReady(apps);
    const call = execute(a, YieldCheckWorkflowStart, item("gate"));
    await until(() => yieldSeen.runs.length === 1, "the root's step at its gate on A");

    // B freezes; its sweep lists the root still running and asks for its lease at the frozen store
    leases.stall(b);
    await clock.advance(seconds(30));
    await settle();
    // A finishes the tree and releases its lease, then B goes on
    openGate();
    const done = await call;
    leases.resume(b);
    await settle();

    expect(done).toFinishWith(YieldCheckedWorkflowFinish, { name: "gate" });
    expect(await takeoversOf(b, done.executionId, done.executionId)).toEqual([]);
    // B gave back at once what its frozen ask was given: the root's lease is free
    expect(leaseRowOf(b, done.executionId)).toMatchObject({ released: true });
    expect(yieldSeen.runs).toEqual([{ name: "gate", instanceId: "instance-2" }]);
  });
});

describe("#520: a paused child's lease is released, not finished", () => {
  test("a child resting at a pause gives its lease back for its resume; its end finishes it", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(YieldReviewerAgent).thenAnswer(reviewer);
    const [a, b] = await bothReady(apps);
    // the tree rests paused with its child's pause; the answer runs the child again, to its end
    const rest = await execute(a, YieldReviewsWorkflowStart, [item("ask")]);
    const child = childOf(b);
    const paused = leaseRowOf(b, child.executionId);
    const pausedRow = statusOf(b, child);
    const answer = { pauseId: yieldSeen.pauseIds[0] ?? "", decision: { approved: true } };
    const answered = await b.resume(answer, { tenantId: "default" });

    expect(rest.status).toBe(ExecutionStatus.Paused);
    expect(pausedRow).toBe(ExecutionRecordStatus.Paused);
    expect(paused).toMatchObject({ released: true, lease: { leaseEpoch: 1 } });
    expect(paused?.isFinished).toBeUndefined();
    expect(answered.status).toBe(ExecutionStatus.Finished);
    expect(leaseRowOf(b, child.executionId)).toMatchObject({
      released: true,
      isFinished: true,
      lease: { leaseEpoch: 2 },
    });
    expect(await takeoversOf(b, child.rootExecutionId, child.executionId)).toEqual([]);
  });
});
