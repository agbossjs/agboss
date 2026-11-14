/**
 * #941 I17: a pause of an any-instance child (`ChildPlacement.AnyInstance`) expires through its
 * root — the root's lease, the root's record, the root's drain; its deadline is the run's, the
 * child's frame carries the root's. The root fails with `DeadlineExceededError`, the child's pause
 * is `Expired`, the instance that did not start the run may be the one that expires it.
 */
import { beforeEach, describe, expect } from "vitest";
import {
  ExecutionRecordRepository,
  PausedExecutionRepository,
  PauseResolution,
  PauseStatus,
} from "../../../src/index.js";
import { callTool, replyWith, testWith, type ModelRequest } from "../../../src/testing/index.js";
import { minutes } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import { until } from "../../channels/fixtures/pause-scripts.js";
import { resetRecovery } from "../../infrastructure/fixtures/recovery.workflow.js";
import {
  ConfirmReviewTool,
  ItemReviewerAgent,
  resetChildLog,
} from "./fixtures/children.workflow.js";
import { ItemResultDto } from "./fixtures/fan-out.workflow.js";
import { resetRecoveryRuns } from "./fixtures/launch-recovery.workflow.js";
import {
  RemoteRecoveryApplication,
  RemoteReviewItemsWorkflowStart,
  resetRemoteRecoverySeen,
} from "./fixtures/remote-recovery.workflow.js";

const test = testWith(RemoteRecoveryApplication, { instances: 2 });
const who = { tenant: { tenantId: "acme", plan: "pro" }, execution: { userId: "u1" } };

const nameIn = (request: ModelRequest): string => {
  const input = typeof request.input === "string" ? request.input : JSON.stringify(request.input);
  return /"name": "(\w+)"/.exec(input)?.[1] ?? "?";
};

beforeEach(() => {
  resetChildLog();
  resetRecovery();
  resetRecoveryRuns();
  resetRemoteRecoverySeen();
});

describe("#941 I17: an any-instance child's pause expires through its root", () => {
  test("bound by the run's deadline: the pause is expired, the root fails with DeadlineExceededError", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(ItemReviewerAgent).thenAnswer((request) => {
      const confirmed =
        request.kind === "chat" && request.messages.some((line) => line.role === "tool");
      return nameIn(request) === "b" && !confirmed
        ? callTool(ConfirmReviewTool, { name: "b" })
        : replyWith(ItemResultDto, { name: nameIn(request) });
    });
    const [first, second] = apps;
    if (first === undefined || second === undefined) throw new Error("two instances");
    await second.ready();
    await first.ready();

    const paused = await execute(
      first,
      RemoteReviewItemsWorkflowStart,
      [
        { name: "a", delay: 0, outcome: "ok" },
        { name: "b", delay: 0, outcome: "ok" },
      ],
      { ...who, deadline: minutes(5) },
    );
    expect(paused.pending[0]?.childExecutionId).toBeDefined();
    const expiresAt = new Date(clock.now().getTime() + minutes(5)).toISOString();
    expect(paused.pending[0]?.expiresAt).toBe(expiresAt);

    await clock.advance(minutes(5));
    const pauses = first.resolve(PausedExecutionRepository);
    await until(async () => {
      const [pause] = await pauses.findAllByTenantIdAndRootExecutionId("acme", paused.executionId);
      return pause?.status === PauseStatus.Cancelled;
    });

    const [pause] = await pauses.findAllByTenantIdAndRootExecutionId("acme", paused.executionId);
    expect(pause).toMatchObject({
      resolution: PauseResolution.Expired,
      expiresAt,
      executionId: paused.pending[0]?.childExecutionId,
    });
    await until(async () => {
      const record = await first
        .resolve(ExecutionRecordRepository)
        .findByTenantIdAndRunId("acme", paused.executionId);
      return record?.status === "failed";
    });
    const record = await first
      .resolve(ExecutionRecordRepository)
      .findByTenantIdAndRunId("acme", paused.executionId);
    expect(record?.stopReason).toContain("deadline");
  });
});
