/**
 * #1307 / #1310 (b17): what a pause target owns of its pauses' lives — `assign` and `resolveTimeout`
 * when a pause opens, `externalRef` from `ChannelOutcome.awaitReply({ externalRef })`, an in-place
 * reassignment (same id, `onPauseReassigned`), a cross-target reassignment (a new pause, the old
 * channel told `closed`), `escalationLimits.maxReassignments` (atomic), `permitReassign` before any
 * hook of the destination, and `onExpired` handing a pause to the next tier.
 */
import { beforeEach, describe, expect } from "vitest";
import { Application } from "../../src/application/application.js";
import { ChannelOutcome } from "../../src/channels/channel-outcome.js";
import type { AssignContext, ExpiredContext } from "../../src/channels/pause-contexts.js";
import { PauseExpiration } from "../../src/channels/pause-expiration.js";
import { Channel } from "../../src/components/decorators.js";
import { ExternalTask } from "../../src/channels/pause-targets.js";
import { Action } from "../../src/flow/decorators/action.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../src/flow/decorators/workflow-start.js";
import { Ttl } from "../../src/index.js";
import { PauseError, PauseResolution, PauseStatus } from "../../src/index.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import type { PauseRecord } from "../../src/infrastructure/pause-record.js";
import { PauseRespondent } from "../../src/pause/respondent.js";
import type {
  ChannelPauseClosedEvent,
  ChannelPauseReassignedEvent,
} from "../../src/pause/notice-events.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { hours, minutes } from "../../src/units/index.js";
import { days } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import {
  ExpiryDecisionDto,
  ExpiryDoneDto,
  ExpiryOrderDto,
} from "../flow/fixtures/expiry.fixture.js";
import { onStart } from "../flow/fixtures/paths.js";

/** What the targets and channels were asked, and what a test makes them answer. */
const told = {
  sent: [] as { pauseId: string; assignees?: readonly string[]; replaces?: string }[],
  assignCalls: 0,
  reassigned: [] as ChannelPauseReassignedEvent<TierOneTask>[],
  closed: [] as ChannelPauseClosedEvent<TierOneTask>[],
  /** What `assign` of tier one gives. */
  assignees: ["on-duty-1"] as readonly string[] | undefined,
  /** What `resolveTimeout` of tier one gives. */
  timeout: undefined as ReturnType<typeof hours> | undefined,
  permit: true as unknown,
  permitCalls: 0,
  /** What tier two's channel gives as `externalRef`. */
  tierTwoRef: "SAP-9" as unknown,
  onExpired: undefined as ((ctx: ExpiredContext<TierOneTask>) => unknown) | undefined,
};

beforeEach(() => {
  told.sent.length = 0;
  told.assignCalls = 0;
  told.reassigned.length = 0;
  told.closed.length = 0;
  told.assignees = ["on-duty-1"];
  told.timeout = undefined;
  told.permit = true;
  told.permitCalls = 0;
  told.tierTwoRef = "SAP-9";
  told.onExpired = undefined;
});

@ExternalTask({
  name: "tier-two-external-task",
  description: "The second tier: four hours",
  input: ExpiryOrderDto,
  output: ExpiryDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(4),
})
class TierTwoTask {}

@ExternalTask({
  name: "tier-one-external-task",
  description: "The first tier: a day, one reassignment at most",
  input: ExpiryOrderDto,
  output: ExpiryDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(24),
  escalationLimits: { maxReassignments: 1, maxExtensions: 1, maxTotalTimeout: days(10) },
  escalatesTo: [TierTwoTask],
})
class TierOneTask {
  assign(_ctx: AssignContext<TierOneTask>): readonly string[] | undefined {
    told.assignCalls += 1;
    return told.assignees;
  }

  resolveTimeout() {
    return told.timeout;
  }

  permitReassign(): boolean | Promise<boolean> {
    told.permitCalls += 1;
    return told.permit as boolean | Promise<boolean>;
  }

  onExpired(ctx: ExpiredContext<TierOneTask>) {
    return (told.onExpired?.(ctx) ?? PauseExpiration.fail()) as PauseExpiration<TierOneTask>;
  }
}

@Channel({
  name: "tier-one-jira-channel",
  description: "Opens a Jira issue for tier one",
  target: TierOneTask,
  ttl: days(1),
})
class TierOneChannel {
  send(ask: { pauseId: string; assignees?: readonly string[]; replaces?: { pauseId: string } }) {
    told.sent.push({
      pauseId: ask.pauseId,
      ...(ask.assignees === undefined ? {} : { assignees: ask.assignees }),
      ...(ask.replaces === undefined ? {} : { replaces: ask.replaces.pauseId }),
    });
    return Promise.resolve(ChannelOutcome.awaitReply({ externalRef: "JIRA-1" }));
  }

  onPauseReassigned(event: ChannelPauseReassignedEvent<TierOneTask>): Promise<void> {
    told.reassigned.push(event);
    return Promise.resolve();
  }

  onPauseClosed(event: ChannelPauseClosedEvent<TierOneTask>): Promise<void> {
    told.closed.push(event);
    return Promise.resolve();
  }
}

@Channel({
  name: "tier-two-sap-channel",
  description: "Opens an SAP ticket for tier two",
  target: TierTwoTask,
  ttl: days(1),
})
class TierTwoChannel {
  send(ask: { pauseId: string; assignees?: readonly string[]; replaces?: { pauseId: string } }) {
    told.sent.push({
      pauseId: ask.pauseId,
      ...(ask.assignees === undefined ? {} : { assignees: ask.assignees }),
      ...(ask.replaces === undefined ? {} : { replaces: ask.replaces.pauseId }),
    });
    return Promise.resolve(ChannelOutcome.awaitReply({ externalRef: told.tierTwoRef as string }));
  }
}

/** A real target of another step of the workflow that tier one does not escalate to. */
@ExternalTask({
  name: "outside-external-task",
  description: "A target of the workflow's later step, not in tier one's escalatesTo",
  input: ExpiryDecisionDto,
  output: ExpiryDoneDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(4),
})
class OutsideTask {}

@Channel({
  name: "outside-sap-channel",
  description: "Opens an SAP ticket for the outside target",
  target: OutsideTask,
  ttl: days(1),
})
class OutsideChannel {
  send() {
    return Promise.resolve(ChannelOutcome.awaitReply({ externalRef: "SAP-0" }));
  }
}

@WorkflowStart({ name: "outside-workflow-start", description: "An order", input: ExpiryOrderDto })
class OutsideStart {}

@WorkflowStart({ name: "tiers-workflow-start", description: "An order", input: ExpiryOrderDto })
class TiersStart {}

@WorkflowFinish({ name: "tiers-workflow-finish", description: "Done", output: ExpiryDoneDto })
class TiersFinish {}

@Action({
  name: "record-tier-action",
  description: "Records the tier's decision",
  input: { order: ExpiryOrderDto, decision: ExpiryDecisionDto },
  output: ExpiryDoneDto,
})
class RecordTierAction {
  execute({
    order,
    decision,
  }: {
    order: ExpiryOrderDto;
    decision: ExpiryDecisionDto;
  }): Promise<ExpiryDoneDto> {
    return Promise.resolve({ status: `${order.orderId}: ${decision.approved ? "yes" : "no"}` });
  }
}

@Workflow({
  name: "tiers-workflow",
  version: "1.0.0",
  historyTtl: Ttl.None,
  flow: [
    onStart(TiersStart)
      .toExternalTask(TierOneTask)
      .toAction(RecordTierAction)
      .toFinish(TiersFinish),
  ],
})
class TiersWorkflow {}

@Workflow({
  name: "outside-workflow",
  version: "1.0.0",
  historyTtl: Ttl.None,
  flow: [
    onStart(OutsideStart)
      .toExternalTask(TierOneTask)
      .toExternalTask(OutsideTask)
      .toFinish(TiersFinish),
  ],
})
class OutsideWorkflow {}

@Application({
  name: "tiers-application",
  version: "1.0.0",
  workflows: [TiersWorkflow, OutsideWorkflow],
  providers: [TierOneChannel, TierTwoChannel, OutsideChannel],
  budgets: TEST_BUDGETS,
})
class TiersApplication {}

const test = testWith(TiersApplication);
const operator = { actor: { id: "operator-1", orgId: "hq" } };

const pausesOf = (app: TestApp, rootId: string): Promise<readonly PauseRecord[]> =>
  app.resolve(PausedExecutionRepository).findAllByTenantIdAndRootExecutionId("default", rootId);

async function opened(app: TestApp): Promise<{ pauseId: string; rootId: string }> {
  const paused = await execute(app, TiersStart, { orderId: "o-1" }, { threadId: "tiers-1" });
  return { pauseId: told.sent[0]?.pauseId ?? "", rootId: paused.executionId };
}

describe("a pause opens under its target's hooks", () => {
  test("assign says who it is for, resolveTimeout how long it waits, the channel's reference is kept", async ({
    app,
    clock,
  }) => {
    told.timeout = hours(6);
    const { rootId } = await opened(app);

    const [pause] = await pausesOf(app, rootId);
    expect(pause).toMatchObject({
      assignees: ["on-duty-1"],
      externalRef: "JIRA-1",
      target: "tier-one-external-task",
      channel: "tier-one-jira-channel",
    });
    expect((pause?.expiresAt?.getTime() ?? Number.NaN) - clock.now().getTime()).toBe(hours(6));
    expect(pause?.trail[0]).toMatchObject({
      action: "opened",
      assignees: ["on-duty-1"],
      externalRef: "JIRA-1",
    });
    expect(told.sent[0]).toMatchObject({ assignees: ["on-duty-1"] });
  });

  test("an empty list and undefined both mean nobody in particular; the declared timeout stands", async ({
    app,
    clock,
  }) => {
    told.assignees = [];
    const { rootId } = await opened(app);

    const [pause] = await pausesOf(app, rootId);
    expect(pause?.assignees).toBeUndefined();
    expect(told.sent[0]?.assignees).toBeUndefined();
    expect((pause?.expiresAt?.getTime() ?? Number.NaN) - clock.now().getTime()).toBe(hours(24));
  });

  test("a bad list from assign, or a timeout under a second, stops the opening: nothing is recorded", async ({
    app,
  }) => {
    told.assignees = ["a", "a"];
    const failed = await execute(
      app,
      TiersStart,
      { orderId: "o-2" },
      { threadId: "tiers-2" },
    ).catch((error: unknown) => error);
    expect(failed).toBeDefined();
    expect(told.sent).toEqual([]);
  });
});

describe("a reassignment that keeps the target and the channel changes the pause in place", () => {
  test("same id, same reference, a reassigned entry; the channel hears onPauseReassigned, nobody is sent anything", async ({
    app,
  }) => {
    const { pauseId, rootId } = await opened(app);

    const moved = await app.reassignPause(
      { pauseId, assignees: ["deputy-2"], reason: "on leave" },
      operator,
    );

    const [pause] = await pausesOf(app, rootId);
    expect(pause).toMatchObject({
      pauseId,
      status: PauseStatus.Pending,
      assignees: ["deputy-2"],
      externalRef: "JIRA-1",
    });
    expect(pause?.trail.map((entry) => entry.action)).toEqual(["opened", "reassigned"]);
    expect(pause?.trail[1]).toMatchObject({
      actor: { id: "operator-1", orgId: "hq" },
      reason: "on leave",
      assignees: ["deputy-2"],
      externalRef: "JIRA-1",
    });
    expect(moved).toMatchObject({ target: "tier-one-external-task", assignees: ["deputy-2"] });
    expect(told.sent).toHaveLength(1);
    await until(() => told.reassigned.length === 1);
    expect(told.reassigned[0]).toMatchObject({
      pauseId,
      previousAssignees: ["on-duty-1"],
      assignees: ["deputy-2"],
      externalRef: "JIRA-1",
      reason: "on leave",
    });
    // the pause still answers under its own id
    const done = await app.resume({ pauseId, decision: { approved: true } }, operator);
    expect(done.status).toBe("finished");
  });

  test("[] releases the pause back to nobody in particular; its deadline is kept", async ({
    app,
  }) => {
    const { pauseId, rootId } = await opened(app);
    const [before] = await pausesOf(app, rootId);

    await app.reassignPause({ pauseId, assignees: [] }, operator);

    const [pause] = await pausesOf(app, rootId);
    expect(pause?.assignees).toBeUndefined();
    expect(pause?.expiresAt).toEqual(before?.expiresAt);
  });

  test("a timeout moves the deadline in the same write", async ({ app, clock }) => {
    const { pauseId, rootId } = await opened(app);

    const moved = await app.reassignPause(
      { pauseId, assignees: ["a-9"], timeout: hours(2) },
      operator,
    );

    const [pause] = await pausesOf(app, rootId);
    expect((pause?.expiresAt?.getTime() ?? Number.NaN) - clock.now().getTime()).toBe(hours(2));
    expect(moved.expiresAt?.toISOString()).toEqual(pause?.expiresAt?.toISOString());
  });

  test("a deadline alone is setPauseTimeout's change: refused; with other changes it counts as an extension, once, even at once", async ({
    app,
  }) => {
    const { pauseId, rootId } = await opened(app);
    expect(
      await app.reassignPause({ pauseId, timeout: hours(2) }, operator).catch((e: unknown) => e),
    ).toBeInstanceOf(PauseError.InvalidTimeout);

    const results = await Promise.allSettled([
      app.reassignPause({ pauseId, assignees: ["a-1"], timeout: hours(2) }, operator),
      app.reassignPause({ pauseId, assignees: ["a-2"], timeout: hours(3) }, operator),
    ]);

    expect(results.filter((one) => one.status === "fulfilled")).toHaveLength(1);
    const [pause] = await pausesOf(app, rootId);
    expect(pause?.trail.filter((entry) => entry.action === "timeout-changed")).toHaveLength(1);
  });

  test("maxReassignments is atomic: of two reassignments at once exactly one wins", async ({
    app,
  }) => {
    const { pauseId, rootId } = await opened(app);

    const results = await Promise.allSettled([
      app.reassignPause({ pauseId, assignees: ["a-1"] }, operator),
      app.reassignPause({ pauseId, assignees: ["a-2"] }, operator),
    ]);

    expect(results.filter((one) => one.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((one) => one.status === "rejected");
    expect(refused?.status === "rejected" ? refused.reason : undefined).toBeInstanceOf(
      PauseError.EscalationLimitExceeded,
    );
    const [pause] = await pausesOf(app, rootId);
    expect(pause?.trail.filter((entry) => entry.action === "reassigned")).toHaveLength(1);
  });

  test("a second reassignment past the limit is refused and changes nothing", async ({ app }) => {
    const { pauseId, rootId } = await opened(app);
    await app.reassignPause({ pauseId, assignees: ["a-1"] }, operator);

    const refused = await app
      .reassignPause({ pauseId, assignees: ["a-2"] }, operator)
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(PauseError.EscalationLimitExceeded);
    const [pause] = await pausesOf(app, rootId);
    expect(pause?.assignees).toEqual(["a-1"]);
  });

  test("permitReassign comes first: a refusal runs no hook of the destination and changes nothing", async ({
    app,
  }) => {
    const { pauseId, rootId } = await opened(app);
    const assigned = told.assignCalls;
    told.permit = false;

    const refused = await app
      .reassignPause({ pauseId, assignees: ["deputy-2"] }, operator)
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(PauseError.PermissionDenied);
    expect(told.assignCalls).toBe(assigned);
    const [pause] = await pausesOf(app, rootId);
    expect(pause?.trail).toHaveLength(1);
    expect(pause?.assignees).toEqual(["on-duty-1"]);
  });
});

describe("a reassignment to another target is a new pause", () => {
  test("the old id closes reassigned and its channel is told; the new channel is sent it and its reference kept", async ({
    app,
    clock,
  }) => {
    const { pauseId, rootId } = await opened(app);

    const moved = await app.reassignPause(
      { pauseId, target: TierTwoTask, assignees: ["tier-two-lead"], reason: "escalated" },
      operator,
    );

    const all = await pausesOf(app, rootId);
    const old = all.find((one) => one.pauseId === pauseId);
    const next = all.find((one) => one.reassignedFrom === pauseId);
    expect(old).toMatchObject({
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Reassigned,
    });
    expect(next).toMatchObject({
      target: "tier-two-external-task",
      channel: "tier-two-sap-channel",
      assignees: ["tier-two-lead"],
      status: PauseStatus.Pending,
      externalRef: "SAP-9",
    });
    // the destination's own wait, counted from now
    expect((next?.expiresAt?.getTime() ?? Number.NaN) - clock.now().getTime()).toBe(hours(4));
    expect(next?.trail.map((entry) => entry.action)).toEqual(["opened", "reassigned"]);
    expect(next?.trail[1]).toMatchObject({ target: "tier-two-external-task" });
    expect(moved).toMatchObject({
      target: "tier-two-external-task",
      channel: "tier-two-sap-channel",
    });
    expect(told.sent[1]).toMatchObject({ replaces: pauseId, assignees: ["tier-two-lead"] });
    await until(() => told.closed.length === 1);
    expect(told.closed[0]).toMatchObject({ pauseId, reason: "reassigned" });
    // the old channel is told "closed", never "reassigned" (it keeps the pause no more)
    expect(told.reassigned).toEqual([]);
    // the old id answers nothing; the new one does
    expect(
      await app
        .resume({ pauseId, decision: { approved: true } }, operator)
        .catch((e: unknown) => e),
    ).toBeInstanceOf(Error);
    const done = await app.resume(
      { pauseId: next?.pauseId ?? "", decision: { approved: true } },
      operator,
    );
    expect(done.status).toBe("finished");
  });

  test("a class that is no pause target of the workflow is PauseError.IncompatibleTarget", async ({
    app,
  }) => {
    const { pauseId, rootId } = await opened(app);

    const refused = await app
      .reassignPause({ pauseId, target: TiersStart }, operator)
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(PauseError.IncompatibleTarget);
    expect(await pausesOf(app, rootId)).toHaveLength(1);
  });
});

describe("a reassignment applies only to the pause the permit saw (#1307)", () => {
  test("a change that lands between the permit and the write wins: the reassignment is UpdateContended and overwrites nothing", async ({
    app,
  }) => {
    const { pauseId, rootId } = await opened(app);
    let release: (value: boolean) => void = () => undefined;
    told.permit = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    // planned against the pause as it is now, then held in permitReassign
    const held = app
      .reassignPause({ pauseId, assignees: ["stale"] }, operator)
      .catch((error: unknown) => error);
    await until(() => told.permitCalls === 1);

    await app.setPauseTimeout({ pauseId, timeout: hours(30) }, operator);
    release(true);

    expect(await held).toBeInstanceOf(PauseError.UpdateContended);
    const [pause] = await pausesOf(app, rootId);
    expect(pause?.assignees).toEqual(["on-duty-1"]);
    expect(pause?.trail.map((entry) => entry.action)).toEqual(["opened", "timeout-changed"]);
    // the caller may run the permit again: the retry applies to what the pause is now
    told.permit = true;
    await app.reassignPause({ pauseId, assignees: ["fresh"] }, operator);
    const [after] = await pausesOf(app, rootId);
    expect(after?.assignees).toEqual(["fresh"]);
  });
});

describe("an externalRef a channel gives a reassigned pause is checked as a step's own send is", () => {
  test("a bad reference is a send failure: the replacement stays unsent and nothing is stored", async ({
    app,
  }) => {
    const { pauseId, rootId } = await opened(app);
    told.tierTwoRef = "";

    await app.reassignPause({ pauseId, target: TierTwoTask, assignees: ["lead"] }, operator);

    const next = (await pausesOf(app, rootId)).find((one) => one.reassignedFrom === pauseId);
    expect(next?.isSent).toBe(false);
    expect(next?.externalRef).toBeUndefined();
    expect(next?.trail.every((entry) => entry.externalRef !== "")).toBe(true);
  });
});

describe("a pause moves only to a target its own target escalates to", () => {
  test("a real target of the workflow that is not in escalatesTo is PauseError.IncompatibleTarget, and nothing changes", async ({
    app,
  }) => {
    const paused = await execute(app, OutsideStart, { orderId: "o-2" }, { threadId: "outside-1" });
    const pauseId = told.sent[0]?.pauseId ?? "";

    const refused = await app
      .reassignPause({ pauseId, target: OutsideTask }, operator)
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(PauseError.IncompatibleTarget);
    expect(told.sent).toHaveLength(1);
    expect(await pausesOf(app, paused.executionId)).toMatchObject([
      { pauseId, status: PauseStatus.Pending },
    ]);
  });
});

describe("onExpired is the target's call", () => {
  test("PauseExpiration.reassign({ target }) hands the expired pause to the next tier, once", async ({
    app,
    clock,
  }) => {
    let calls = 0;
    told.onExpired = () => {
      calls += 1;
      return PauseExpiration.reassign({ target: TierTwoTask, reason: "no answer in a day" });
    };
    const { pauseId, rootId } = await opened(app);

    await clock.advance(hours(24));
    await until(() => calls === 1);
    // the re-send look asks the new channel
    await clock.advance(minutes(1));
    await until(() => told.sent.length === 2);

    const all = await pausesOf(app, rootId);
    expect(all.find((one) => one.pauseId === pauseId)).toMatchObject({
      resolution: PauseResolution.Reassigned,
    });
    const next = all.find((one) => one.reassignedFrom === pauseId);
    expect(next).toMatchObject({
      target: "tier-two-external-task",
      status: PauseStatus.Pending,
      externalRef: "SAP-9",
    });
    expect(next?.trail[1]).toMatchObject({ reason: "no answer in a day" });
    expect(calls).toBe(1);
    // tier two's own four hours are counted from the expiry
    await clock.advance(minutes(1));
    expect(calls).toBe(1);
  });

  test("an automatic reassignment does not call permitReassign: it is the target's own policy, there is no actor (Q-F)", async ({
    app,
    clock,
  }) => {
    // a target whose permit refuses everything still escalates by its own expiry
    told.permit = false;
    let calls = 0;
    told.onExpired = () => {
      calls += 1;
      return PauseExpiration.reassign({ target: TierTwoTask });
    };
    const { pauseId, rootId } = await opened(app);

    await clock.advance(hours(24));
    await until(() => calls === 1);
    await clock.advance(minutes(1));
    await until(() => told.sent.length === 2);

    expect(told.permitCalls).toBe(0);
    const all = await pausesOf(app, rootId);
    expect(all.find((one) => one.reassignedFrom === pauseId)).toMatchObject({
      target: "tier-two-external-task",
      status: PauseStatus.Pending,
    });
  });

  test("the context carries maxExpiresAt: the first asking plus the chain's maxTotalTimeout", async ({
    app,
    clock,
  }) => {
    const seen: ExpiredContext<TierOneTask>[] = [];
    told.onExpired = (ctx) => {
      seen.push(ctx);
      return PauseExpiration.fail();
    };
    await opened(app);
    const startedAt = clock.now().getTime();

    await clock.advance(hours(24));
    await until(() => seen.length === 1);

    const ctx = seen[0];
    expect(ctx?.maxExpiresAt).toBeInstanceOf(Date);
    expect(ctx?.maxExpiresAt?.getTime()).toBe((ctx?.firstAskedAt.getTime() ?? 0) + days(10));
    expect(ctx?.firstAskedAt.getTime()).toBeLessThanOrEqual(startedAt);
  });

  test("a target with no onExpired fails its expired pause", async ({ app, clock }) => {
    const { rootId } = await opened(app);

    await clock.advance(hours(24));
    await until(async () =>
      (await pausesOf(app, rootId)).some((one) => one.resolution === PauseResolution.Expired),
    );

    expect((await pausesOf(app, rootId))[0]).toMatchObject({ resolution: PauseResolution.Expired });
  });
});
