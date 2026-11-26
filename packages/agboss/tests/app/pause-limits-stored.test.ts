/**
 * #1307, Q-D: a pause carries the limits it was opened under (`firstAskedAt`, `maxExpiresAt`,
 * `escalationLimits`), narrowed by each move to another target; every check reads the record, never
 * the application's present configuration. A deploy since the pause was opened — a target renamed or
 * removed, its limits loosened or dropped — loosens nothing for a pause already waiting.
 *
 * The live configuration here is the LOOSE one; a record "written by an earlier deploy" is the
 * opened pause with the limits and the chain of custody of that deploy.
 */
import { describe, expect } from "vitest";
import { Application } from "../../src/application/application.js";
import { ChannelOutcome } from "../../src/channels/channel-outcome.js";
import type { ExpiredContext } from "../../src/channels/pause-contexts.js";
import { PauseExpiration } from "../../src/channels/pause-expiration.js";
import { ExternalTask } from "../../src/channels/pause-targets.js";
import { Channel } from "../../src/components/decorators.js";
import { Action } from "../../src/flow/decorators/action.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../src/flow/decorators/workflow-start.js";
import { PauseError, PauseStatus, Ttl } from "../../src/index.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import type { PauseRecord } from "../../src/infrastructure/pause-record.js";
import { PauseRespondent } from "../../src/pause/respondent.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { days, hours } from "../../src/units/index.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import {
  ExpiryDecisionDto,
  ExpiryDoneDto,
  ExpiryOrderDto,
} from "../flow/fixtures/expiry.fixture.js";
import { onStart } from "../flow/fixtures/paths.js";
import { execute } from "../helpers/flow.js";

const told = { sent: [] as string[], expired: [] as ExpiredContext<LooseTask>[] };

@ExternalTask({
  name: "stored-second-external-task",
  description: "The second tier: no limits at all",
  input: ExpiryOrderDto,
  output: ExpiryDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(4),
})
class SecondTask {}

@ExternalTask({
  name: "stored-tight-external-task",
  description: "A tight tier: ten hours in total, two reassignments, three changes",
  input: ExpiryOrderDto,
  output: ExpiryDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(4),
  escalationLimits: { maxExtensions: 3, maxReassignments: 2, maxTotalTimeout: hours(10) },
})
class TightTask {}

@ExternalTask({
  name: "stored-loose-external-task",
  description: "The live configuration: far looser than what the pauses were opened under",
  input: ExpiryOrderDto,
  output: ExpiryDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(24),
  escalationLimits: { maxExtensions: 99, maxReassignments: 99, maxTotalTimeout: days(30) },
  escalatesTo: [SecondTask, TightTask],
})
class LooseTask {
  onExpired(ctx: ExpiredContext<LooseTask>) {
    told.expired.push(ctx);
    return PauseExpiration.fail() as PauseExpiration<LooseTask>;
  }
}

@Channel({ name: "stored-loose-channel", description: "Asks", target: LooseTask, ttl: days(1) })
class LooseChannel {
  send(ask: { pauseId: string }) {
    told.sent.push(ask.pauseId);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Channel({ name: "stored-tight-channel", description: "Asks", target: TightTask, ttl: days(1) })
class TightChannel {
  send(ask: { pauseId: string }) {
    told.sent.push(ask.pauseId);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Channel({ name: "stored-second-channel", description: "Asks", target: SecondTask, ttl: days(1) })
class SecondChannel {
  send(ask: { pauseId: string }) {
    told.sent.push(ask.pauseId);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@WorkflowStart({ name: "stored-workflow-start", description: "An order", input: ExpiryOrderDto })
class StoredStart {}

@WorkflowStart({
  name: "stored-plain-workflow-start",
  description: "An order",
  input: ExpiryOrderDto,
})
class PlainStart {}

@WorkflowFinish({ name: "stored-workflow-finish", description: "Done", output: ExpiryDoneDto })
class StoredFinish {}

@Action({
  name: "record-stored-action",
  description: "Records the decision",
  input: { order: ExpiryOrderDto, decision: ExpiryDecisionDto },
  output: ExpiryDoneDto,
})
class RecordStoredAction {
  execute() {
    return Promise.resolve({ status: "ok" });
  }
}

@Workflow({
  name: "stored-workflow",
  version: "1.0.0",
  historyTtl: Ttl.None,
  flow: [
    onStart(StoredStart)
      .toExternalTask(LooseTask)
      .toAction(RecordStoredAction)
      .toFinish(StoredFinish),
  ],
})
class StoredWorkflow {}

@Workflow({
  name: "stored-plain-workflow",
  version: "1.0.0",
  historyTtl: Ttl.None,
  flow: [
    onStart(PlainStart)
      .toExternalTask(SecondTask)
      .toAction(RecordStoredAction)
      .toFinish(StoredFinish),
  ],
})
class PlainWorkflow {}

@Application({
  name: "stored-limits-application",
  version: "1.0.0",
  workflows: [StoredWorkflow, PlainWorkflow],
  providers: [LooseChannel, SecondChannel, TightChannel],
  budgets: TEST_BUDGETS,
})
class StoredApplication {}

const test = testWith(StoredApplication);
const operator = { actor: { id: "operator-1" } };
const store = (app: TestApp) => app.resolve(PausedExecutionRepository);

async function opened(app: TestApp, start: typeof StoredStart | typeof PlainStart, thread: string) {
  const paused = await execute(app, start, { orderId: "o-1" }, { threadId: thread });
  const [pause] = await store(app).findAllByTenantIdAndRootExecutionId(
    "default",
    paused.executionId,
  );
  if (pause === undefined) throw new Error("no pause was opened");
  return pause;
}

/** The live pause as a deploy with other limits wrote it: the same pause, other limits and chain. */
async function carried(app: TestApp, now: PauseRecord, written: Partial<PauseRecord>) {
  return store(app).findOrCreateByStepKey({
    ...now,
    pauseId: "carried-pause",
    stepKey: `${now.stepKey}~carried`,
    ...written,
  });
}

const entry = (action: "reassigned" | "timeout-changed", target: string, at: string) =>
  ({ action, at, target, channel: "stored-loose-channel" }) as const;

describe("a pause is opened with its limits materialized", () => {
  test("firstAskedAt, maxExpiresAt (the target's maxTotalTimeout from the first asking) and the counts", async ({
    app,
    clock,
  }) => {
    const pause = await opened(app, StoredStart, "stored-open");

    expect(pause.firstAskedAt).toBe(pause.askedAt);
    expect(pause.firstAskedAt).toBe(clock.now().toISOString());
    expect(pause.maxExpiresAt).toBe(new Date(clock.now().getTime() + days(30)).toISOString());
    expect(pause.escalationLimits).toEqual({ maxExtensions: 99, maxReassignments: 99 });
  });

  test("a target with no limits: no maxExpiresAt, no counts — an empty `escalationLimits`, never absent", async ({
    app,
  }) => {
    const pause = await opened(app, PlainStart, "stored-plain");

    expect(pause).not.toHaveProperty("maxExpiresAt");
    expect(pause.escalationLimits).toEqual({});
  });

  test("a move to a tighter target narrows the cap and the counts to the destination's, the total wait counted from the FIRST asking", async ({
    app,
    clock,
  }) => {
    const first = await opened(app, StoredStart, "stored-tight");
    await clock.advance(hours(1));

    await app.reassignPause({ pauseId: first.pauseId, target: TightTask }, operator);
    const moved = (
      await store(app).findAllByTenantIdAndRootExecutionId("default", first.rootExecutionId)
    ).find((one) => one.reassignedFrom === first.pauseId);

    expect(moved).toMatchObject({
      target: "stored-tight-external-task",
      firstAskedAt: first.firstAskedAt,
      // ten hours from the first asking, not from the move an hour later
      maxExpiresAt: new Date(Date.parse(first.firstAskedAt) + hours(10)).toISOString(),
      escalationLimits: { maxExtensions: 3, maxReassignments: 2 },
    });
    // and the narrowed limits are the ones that now hold: nine hours from now is past the cap
    await expect(
      app.setPauseTimeout({ pauseId: moved?.pauseId ?? "", timeout: hours(10) }, operator),
    ).rejects.toBeInstanceOf(PauseError.EscalationLimitExceeded);
    await app.setPauseTimeout({ pauseId: moved?.pauseId ?? "", timeout: hours(9) }, operator);
  });

  test("a move to another target keeps what the pause had when the destination offers none (the smaller of the two, per field) and the replacement keeps firstAskedAt", async ({
    app,
    clock,
  }) => {
    const first = await opened(app, StoredStart, "stored-move");
    await clock.advance(hours(1));

    await app.reassignPause({ pauseId: first.pauseId, target: SecondTask }, operator);
    const moved = (
      await store(app).findAllByTenantIdAndRootExecutionId("default", first.rootExecutionId)
    ).find((one) => one.reassignedFrom === first.pauseId);

    // the second tier offers no limits: the first's stay, whatever the live configuration says
    expect(moved).toMatchObject({
      firstAskedAt: first.firstAskedAt,
      maxExpiresAt: first.maxExpiresAt,
      escalationLimits: { maxExtensions: 99, maxReassignments: 99 },
    });
  });
});

describe("the limits are the record's, not the live configuration's", () => {
  test("setPauseTimeout past the stored maxExpiresAt is refused though the live target allows 30 days", async ({
    app,
    clock,
  }) => {
    const now = await opened(app, StoredStart, "stored-cap");
    const capped = await carried(app, now, {
      maxExpiresAt: new Date(clock.now().getTime() + hours(48)).toISOString(),
    });

    await expect(
      app.setPauseTimeout({ pauseId: capped.pauseId, timeout: hours(49) }, operator),
    ).rejects.toThrow("maxTotalTimeout");
    const ok = await app.setPauseTimeout({ pauseId: capped.pauseId, timeout: hours(48) }, operator);
    expect(ok.expiresAt?.getTime()).toBe(clock.now().getTime() + hours(48));
  });

  test("setPauseTimeout: the stored maxExtensions counts", async ({ app, clock }) => {
    const now = await opened(app, StoredStart, "stored-ext");
    const at = clock.now().toISOString();
    const spent = await carried(app, now, {
      escalationLimits: { maxExtensions: 1 },
      trail: [...now.trail, entry("timeout-changed", now.target, at)],
    });

    await expect(
      app.setPauseTimeout({ pauseId: spent.pauseId, timeout: hours(30) }, operator),
    ).rejects.toThrow("maxExtensions");
  });

  test("reassignPause: the stored maxReassignments counts", async ({ app, clock }) => {
    const now = await opened(app, StoredStart, "stored-reassign");
    const at = clock.now().toISOString();
    const spent = await carried(app, now, {
      escalationLimits: { maxReassignments: 1 },
      trail: [...now.trail, entry("reassigned", now.target, at)],
    });

    await expect(
      app.reassignPause({ pauseId: spent.pauseId, assignees: ["deputy"] }, operator),
    ).rejects.toThrow("maxReassignments");
    // not changed: still waiting, still as it was
    expect((await store(app).findByTenantIdAndPauseId("default", spent.pauseId))?.assignees).toBe(
      undefined,
    );
  });

  test("a target the chain went through and a deploy removed still limits it: the record carries what it set", async ({
    app,
    clock,
  }) => {
    const now = await opened(app, StoredStart, "stored-removed");
    const at = clock.now().toISOString();
    // the pause was opened under `retired-external-task` (no longer in the application), moved on
    // to the live target; it carries the 10-hour total wait of the one that is gone
    const moved = await carried(app, now, {
      maxExpiresAt: new Date(clock.now().getTime() + hours(10)).toISOString(),
      trail: [
        { ...now.trail[0], target: "retired-external-task" } as never,
        entry("reassigned", now.target, at),
      ],
    });

    await expect(
      app.setPauseTimeout({ pauseId: moved.pauseId, timeout: hours(11) }, operator),
    ).rejects.toThrow("maxTotalTimeout");
    const ok = await app.setPauseTimeout({ pauseId: moved.pauseId, timeout: hours(10) }, operator);
    expect(ok.expiresAt?.getTime()).toBe(clock.now().getTime() + hours(10));
  });

  test("a reassignment's new deadline is cut at the stored maxExpiresAt", async ({
    app,
    clock,
  }) => {
    const now = await opened(app, StoredStart, "stored-deadline");
    const capped = await carried(app, now, {
      maxExpiresAt: new Date(clock.now().getTime() + hours(6)).toISOString(),
    });

    await app.reassignPause(
      { pauseId: capped.pauseId, target: SecondTask, timeout: hours(20) },
      operator,
    );
    const replacement = (
      await store(app).findAllByTenantIdAndRootExecutionId("default", now.rootExecutionId)
    ).find((one) => one.reassignedFrom === capped.pauseId);

    expect(replacement?.status).toBe(PauseStatus.Pending);
    expect(replacement?.expiresAt).toBe(new Date(clock.now().getTime() + hours(6)).toISOString());
  });

  test("a change in place narrows nothing: the stored cap, not the live target's 30 days, bounds its new deadline", async ({
    app,
    clock,
  }) => {
    const now = await opened(app, StoredStart, "stored-in-place");
    // opened under a laxer deploy: sixty days in total, where the live target allows thirty
    const lax = await carried(app, now, {
      maxExpiresAt: new Date(clock.now().getTime() + days(60)).toISOString(),
    });

    await app.reassignPause(
      { pauseId: lax.pauseId, assignees: ["deputy"], timeout: days(40) },
      operator,
    );

    const after = await store(app).findByTenantIdAndPauseId("default", lax.pauseId);
    expect(after?.expiresAt).toBe(new Date(clock.now().getTime() + days(40)).toISOString());
    expect(after?.maxExpiresAt).toBe(lax.maxExpiresAt);
  });

  test("onExpired reads the stored maxExpiresAt and firstAskedAt", async ({ app, clock }) => {
    const now = await opened(app, StoredStart, "stored-context");
    const cap = new Date(clock.now().getTime() + days(3));
    await carried(app, now, { maxExpiresAt: cap.toISOString() });

    await clock.advance(hours(25));
    await until(() => told.expired.length >= 2);

    const ctx = told.expired.find((one) => one.maxExpiresAt?.getTime() === cap.getTime());
    expect(ctx?.firstAskedAt).toEqual(new Date(now.firstAskedAt));
  });
});
