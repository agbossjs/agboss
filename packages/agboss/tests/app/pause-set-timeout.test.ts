/**
 * #1307: `app.setPauseTimeout` under the target's own rules — `permitTimeoutChange` (fail closed,
 * called before anything is written), the chain's `escalationLimits` (`maxExtensions`,
 * `maxTotalTimeout`), a first send still in flight (`PauseError.UpdateContended`), and what the chain
 * of custody keeps (who, why, to what).
 */
import { beforeEach, describe, expect, vi } from "vitest";
import { Application } from "../../src/application/application.js";
import { ChannelOutcome } from "../../src/channels/channel-outcome.js";
import type { TimeoutPermissionContext } from "../../src/channels/pause-contexts.js";
import { ExternalTask } from "../../src/channels/pause-targets.js";
import { Channel } from "../../src/components/decorators.js";
import { Action } from "../../src/flow/decorators/action.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../src/flow/decorators/workflow-start.js";
import {
  PauseError,
  PauseStatus,
  PiiKind,
  PiiPolicy,
  Ttl,
  ValidationError,
} from "../../src/index.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { PauseRespondent } from "../../src/pause/respondent.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { days, hours, Timeout } from "../../src/units/index.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import {
  ExpiryDecisionDto,
  ExpiryDoneDto,
  ExpiryOrderDto,
} from "../flow/fixtures/expiry.fixture.js";
import { onStart } from "../flow/fixtures/paths.js";
import { execute } from "../helpers/flow.js";

/** What the target was asked and what a test makes it answer. */
const told = {
  sent: [] as string[],
  permitted: [] as TimeoutPermissionContext<GatedTask>[],
  /** What `permitTimeoutChange` gives; a function is called, an error is thrown. */
  verdict: true as unknown,
  /** A first send waits for this to be released. */
  hold: undefined as Promise<void> | undefined,
  changed: [] as { expiresAt?: string; previousExpiresAt?: string }[],
};

beforeEach(() => {
  told.sent.length = 0;
  told.permitted.length = 0;
  told.verdict = true;
  told.hold = undefined;
  told.changed.length = 0;
});

@ExternalTask({
  name: "gated-timeout-external-task",
  description: "A day, two hours' reminder, three changes and 48 hours at most, permit-gated",
  input: ExpiryOrderDto,
  output: ExpiryDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(24),
  remindBefore: hours(2),
  escalationLimits: { maxExtensions: 3, maxTotalTimeout: hours(48) },
})
class GatedTask {
  permitTimeoutChange(ctx: TimeoutPermissionContext<GatedTask>): boolean | Promise<boolean> {
    told.permitted.push(ctx);
    if (told.verdict instanceof Error) throw told.verdict;
    if (typeof told.verdict === "function") return (told.verdict as () => Promise<boolean>)();
    return told.verdict as boolean;
  }
}

@Channel({
  name: "gated-timeout-channel",
  description: "Asks, and can be held in its first send",
  target: GatedTask,
  ttl: days(1),
})
class GatedChannel {
  async send(ask: { pauseId: string }) {
    told.sent.push(ask.pauseId);
    await told.hold;
    return ChannelOutcome.awaitReply();
  }

  onPauseTimeoutChanged(event: { expiresAt?: string; previousExpiresAt?: string }): Promise<void> {
    told.changed.push(event);
    return Promise.resolve();
  }
}

@WorkflowStart({ name: "gated-workflow-start", description: "An order", input: ExpiryOrderDto })
class GatedStart {}

@WorkflowFinish({ name: "gated-workflow-finish", description: "Done", output: ExpiryDoneDto })
class GatedFinish {}

@Action({
  name: "record-gated-action",
  description: "Records the decision",
  input: { order: ExpiryOrderDto, decision: ExpiryDecisionDto },
  output: ExpiryDoneDto,
})
class RecordGatedAction {
  execute({ order }: { order: ExpiryOrderDto }): Promise<ExpiryDoneDto> {
    return Promise.resolve({ status: order.orderId });
  }
}

@PiiPolicy({
  name: "gated-email-pii-policy",
  description: "Hides e-mails",
  rules: [PiiKind.Email.mask()],
})
class GatedEmailPolicy {}

@Workflow({
  name: "gated-workflow",
  piiPolicies: [GatedEmailPolicy],
  version: "1.0.0",
  historyTtl: Ttl.None,
  flow: [
    onStart(GatedStart).toExternalTask(GatedTask).toAction(RecordGatedAction).toFinish(GatedFinish),
  ],
})
class GatedWorkflow {}

@Application({
  name: "gated-timeout-application",
  version: "1.0.0",
  workflows: [GatedWorkflow],
  providers: [GatedChannel],
  budgets: TEST_BUDGETS,
})
class GatedApplication {}

const test = testWith(GatedApplication);
const operator = { actor: { id: "operator-1", orgId: "hq" } };

const pauseOf = async (app: TestApp, pauseId: string) => {
  const found = await app
    .resolve(PausedExecutionRepository)
    .findByTenantIdAndPauseId("default", pauseId);
  if (found === undefined) throw new Error("the pause is gone");
  return found;
};

async function opened(app: TestApp): Promise<string> {
  await execute(app, GatedStart, { orderId: "o-1" }, { threadId: "gated-1" });
  return told.sent[0] ?? "";
}

const failureOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("permitTimeoutChange: asked before anything is written; fails closed", () => {
  test("true permits: it reads who, how long, the deadline now and why, and the change is applied", async ({
    app,
    clock,
  }) => {
    const pauseId = await opened(app);
    const before = await pauseOf(app, pauseId);
    await clock.advance(hours(1));

    const changed = await app.setPauseTimeout(
      { pauseId, timeout: hours(10), reason: "customer waits" },
      operator,
    );

    expect(told.permitted).toHaveLength(1);
    expect(told.permitted[0]).toMatchObject({
      actor: { id: "operator-1", orgId: "hq" },
      timeout: hours(10),
      currentExpiresAt: new Date(before.expiresAt ?? ""),
      reason: "customer waits",
      input: { orderId: "o-1" },
    });
    expect(told.permitted[0]?.trail).toHaveLength(1);
    expect(changed.expiresAt).toEqual(new Date(clock.now().getTime() + hours(10)));
  });

  test("Timeout.None is handed to the hook as asked", async ({ app }) => {
    const pauseId = await opened(app);

    await failureOf(app.setPauseTimeout({ pauseId, timeout: Timeout.None }, operator));

    expect(told.permitted[0]?.timeout).toBe(Timeout.None);
  });

  test.for([
    ["false", false],
    ["undefined", undefined],
    ["a truthy text", "yes"],
    ["1", 1],
    ["a rejected promise", () => Promise.reject(new Error("no"))],
    ["a throw", new Error("boom")],
  ] as const)(
    "%s refuses with PauseError.PermissionDenied, and the pause, its chain and its listeners are untouched",
    async ([, verdict], { app, clock }) => {
      const pauseId = await opened(app);
      const before = await pauseOf(app, pauseId);
      await clock.advance(hours(1));
      told.verdict = verdict;

      const refused = await failureOf(
        app.setPauseTimeout({ pauseId, timeout: hours(10) }, operator),
      );

      expect(refused).toBeInstanceOf(PauseError.PermissionDenied);
      expect(await pauseOf(app, pauseId)).toEqual(before);
      expect(told.changed).toEqual([]);
    },
  );

  test("a target that cannot be resolved refuses: whether it has a hook is unknown", async ({
    app,
  }) => {
    const pauseId = await opened(app);
    const store = app.resolve(PausedExecutionRepository);
    const real = store.findByTenantIdAndPauseId.bind(store);
    vi.spyOn(store, "findByTenantIdAndPauseId").mockImplementation(async (tenantId, id) => {
      const found = await real(tenantId, id);
      return found === undefined ? undefined : { ...found, target: "a-target-that-is-gone" };
    });

    const refused = await failureOf(app.setPauseTimeout({ pauseId, timeout: hours(10) }, operator));

    expect(refused).toBeInstanceOf(PauseError.PermissionDenied);
    expect(told.permitted).toEqual([]);
  });

  test("the hook is not asked for a pause that is closed or for a request that is no timeout", async ({
    app,
  }) => {
    const pauseId = await opened(app);

    const invalid = await failureOf(
      app.setPauseTimeout({ pauseId, timeout: 5 as never }, operator),
    );
    await app.resume({ pauseId, decision: { approved: true } }, operator);
    const closed = await failureOf(app.setPauseTimeout({ pauseId, timeout: hours(3) }, operator));

    expect(invalid).toBeInstanceOf(PauseError.InvalidTimeout);
    expect(closed).toBeInstanceOf(PauseError.Closed);
    expect(told.permitted).toEqual([]);
  });
});

describe("the chain of custody and the reason", () => {
  test("a change is a timeout-changed entry: who, when, the new deadline, why", async ({
    app,
    clock,
  }) => {
    const pauseId = await opened(app);
    await clock.advance(hours(1));

    const changed = await app.setPauseTimeout(
      { pauseId, timeout: hours(5), reason: "urgent" },
      operator,
    );

    const entry = (await pauseOf(app, pauseId)).trail.at(-1);
    expect(entry).toMatchObject({
      action: "timeout-changed",
      actor: { id: "operator-1", orgId: "hq" },
      expiresAt: changed.expiresAt?.toISOString(),
      reason: "urgent",
    });
  });

  test("a reason that is blank or too long is ValidationError.DtoInvalid on .reason", async ({
    app,
  }) => {
    const pauseId = await opened(app);

    for (const reason of [" ", "x".repeat(501), 5]) {
      const refused = await failureOf(
        app.setPauseTimeout({ pauseId, timeout: hours(5), reason: reason as never }, operator),
      );
      expect(refused).toBeInstanceOf(ValidationError.DtoInvalid);
      expect(refused).toMatchObject({ issues: [{ path: ".reason" }] });
    }
    expect(told.permitted).toEqual([]);
  });
});

describe("the reason is masked by the pause's workflow's PII policy (#1307)", () => {
  const EMAIL = "jane.roe@example.com";

  test("the chain of custody keeps it masked; permitTimeoutChange read it as given", async ({
    app,
  }) => {
    const pauseId = await opened(app);

    await app.setPauseTimeout(
      { pauseId, timeout: hours(5), reason: `asked by ${EMAIL}` },
      operator,
    );

    const entry = (await pauseOf(app, pauseId)).trail.at(-1);
    expect(entry?.reason).toBeDefined();
    expect(entry?.reason).not.toContain(EMAIL);
    expect(JSON.stringify((await pauseOf(app, pauseId)).trail)).not.toContain(EMAIL);
    expect(told.permitted[0]?.reason).toContain(EMAIL);
  });
});

describe("escalationLimits: maxExtensions and maxTotalTimeout", () => {
  test("maxExtensions: the fourth change of three is PauseError.EscalationLimitExceeded, nothing written", async ({
    app,
  }) => {
    const pauseId = await opened(app);
    for (const timeout of [hours(10), hours(11), hours(12)])
      await app.setPauseTimeout({ pauseId, timeout }, operator);
    const before = await pauseOf(app, pauseId);
    await until(() => told.changed.length === 3);
    told.changed.length = 0;

    const refused = await failureOf(app.setPauseTimeout({ pauseId, timeout: hours(13) }, operator));

    expect(refused).toBeInstanceOf(PauseError.EscalationLimitExceeded);
    expect(await pauseOf(app, pauseId)).toEqual(before);
    expect(told.changed).toEqual([]);
  });

  test("maxTotalTimeout counts from the first asking: exactly the cap is allowed, a minute past it is not", async ({
    app,
    clock,
  }) => {
    const pauseId = await opened(app);
    await clock.advance(hours(2));

    const past = await failureOf(
      app.setPauseTimeout({ pauseId, timeout: hours(46) + 60_000 } as never, operator),
    );
    const exact = await app.setPauseTimeout({ pauseId, timeout: hours(46) }, operator);

    expect(past).toBeInstanceOf(PauseError.EscalationLimitExceeded);
    // asked at 0, now 2 h: 46 h from now is 48 h from asking
    expect(exact.expiresAt).toEqual(new Date(clock.now().getTime() + hours(46)));
  });

  test("no deadline at all is past any cap: Timeout.None is PauseError.EscalationLimitExceeded", async ({
    app,
  }) => {
    const pauseId = await opened(app);
    const before = await pauseOf(app, pauseId);

    const refused = await failureOf(
      app.setPauseTimeout({ pauseId, timeout: Timeout.None }, operator),
    );

    expect(refused).toBeInstanceOf(PauseError.EscalationLimitExceeded);
    expect(await pauseOf(app, pauseId)).toEqual(before);
  });
});

describe("a first send still in flight", () => {
  test("is PauseError.UpdateContended: the channel would hear of the change before it heard of the pause; retry is safe once the send returned", async ({
    app,
  }) => {
    let release: () => void = () => undefined;
    told.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = execute(app, GatedStart, { orderId: "o-1" }, { threadId: "gated-1" });
    await until(() => told.sent.length === 1);
    const pauseId = told.sent[0] ?? "";

    const refused = await failureOf(app.setPauseTimeout({ pauseId, timeout: hours(10) }, operator));
    expect((await pauseOf(app, pauseId)).isSent).toBe(false);
    release();
    await running;
    const applied = await app.setPauseTimeout({ pauseId, timeout: hours(10) }, operator);

    expect(refused).toBeInstanceOf(PauseError.UpdateContended);
    expect(told.permitted).toHaveLength(1);
    expect((await pauseOf(app, pauseId)).status).toBe(PauseStatus.Pending);
    expect(applied.expiresAt).toBeInstanceOf(Date);
  });
});
