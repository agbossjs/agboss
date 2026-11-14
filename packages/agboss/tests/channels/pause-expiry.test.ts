/**
 * #941 AC1 / AC2: a pause with a deadline. At the deadline the look expires it within seconds: the
 * step fails with `PauseExpiredError` (`.onError(PauseExpiredError, …)` escalates) or goes on with
 * the answer the channel decided (`PauseExpiration.decide`), recorded as answered by the expiry;
 * a handler that throws, hangs or gives garbage fails the expiry, its cause an `ExpiryHandlerError`.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { ResumeReason } from "../../src/core/observability.js";
import { PauseExpiration } from "../../src/channels/pause-expiration.js";
import { ExpiryHandlerError, PauseExpiredError } from "../../src/errors.js";
import { ExpiryProblem, PauseResolution, PauseStatus } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { hours, minutes, seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { logged, resetLogged } from "../helpers/log.js";
import { until } from "./fixtures/pause-scripts.js";
import {
  PublicExpiryApplication,
  PublicExpiryWorkflowStart,
} from "../flow/fixtures/expiry-public.fixture.js";
import {
  ExpiryApplication,
  ExpiryWorkflowStart,
  PlainWorkflowStart,
  ReviewerWorkflowStart,
  ShortExpiryWorkflowStart,
  expiry,
  expiryStore,
  resetExpiry,
} from "../flow/fixtures/expiry.fixture.js";

const test = testWith(ExpiryApplication);
const ORDER = { orderId: "o-1" };
const THREAD = { threadId: "expiry-1" };
const AT = (clock: { now(): Date }, delay: number): string =>
  new Date(clock.now().getTime() + delay).toISOString();

beforeEach(() => {
  resetExpiry();
  resetLogged();
});

describe("#941 AC1: a pause nobody answers expires and the step fails", () => {
  test("AC1: 24 h later the look expires it: .onError(PauseExpiredError) asks the director; the log says expired", async ({
    app,
    clock,
  }) => {
    const paused = await execute(app, ExpiryWorkflowStart, ORDER, THREAD);
    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(paused.pending[0]?.expiresAt).toBe(AT(clock, hours(24)));

    await clock.advance(hours(24));
    await until(() => expiry.directorAsked.length === 1);

    const [pause] = await expiryStore().findAllByTenantIdAndRootExecutionId(
      "default",
      paused.executionId,
    );
    expect(pause).toMatchObject({
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Expired,
    });
    const director = expiry.directorAsked[0];
    const done = await app.resume(
      { pauseId: director?.pauseId ?? "", decision: { approved: true } },
      { answeredBy: "director-1", record: true },
    );
    expect(done.record?.pauses).toMatchObject([
      { resolution: PauseResolution.Expired, answeredBy: undefined },
      { resolution: PauseResolution.Replied, answeredBy: "director-1" },
    ]);
    expect(expiry.recorded).toEqual(["o-1: escalated, approved"]);
    // the channel heard it: closed, expired, at the deadline
    await until(() => expiry.closed.length === 1);
    expect(expiry.closed[0]).toMatchObject({ reason: "expired", closedAt: pause?.expiresAt });
  });

  test("AC1: before the deadline nothing expires and the handler is not asked; at it the look does", async ({
    app,
    clock,
  }) => {
    await execute(app, ExpiryWorkflowStart, ORDER, THREAD);

    await clock.advance(seconds(24 * 3600 - 10));
    expect(expiry.asked).toHaveLength(0);
    expect(expiry.directorAsked).toHaveLength(0);

    await clock.advance(seconds(10));
    await until(() => expiry.directorAsked.length === 1);
    expect(expiry.asked).toHaveLength(1);
  });

  test("AC1: a step's expiresIn of 4 h wins over the role's 24 h; its failure is PauseExpiredError", async ({
    app,
    clock,
  }) => {
    const paused = await execute(app, ShortExpiryWorkflowStart, ORDER, THREAD);
    expect(paused.pending[0]?.expiresAt).toBe(AT(clock, hours(4)));

    await clock.advance(hours(4));
    await until(() => expiry.errors.length === 1);

    const [error] = expiry.errors;
    expect(error).toBeInstanceOf(PauseExpiredError);
    expect(error).toMatchObject({
      code: "step.pause-expired",
      step: "expiring-manager-question",
      stepKind: "question",
      channel: "expiring-manager-question",
      kind: "question",
      expiresAt: paused.pending[0]?.expiresAt,
    });
    expect(error?.message).not.toContain(paused.executionId);
    expect(expiry.asked).toHaveLength(1);
  });

  test("AC1: a channel with no expiry handler fails the step at its role's 30 minutes", async ({
    app,
    clock,
  }) => {
    await execute(app, ReviewerWorkflowStart, ORDER, THREAD);

    await clock.advance(minutes(30));
    await until(() => expiry.errors.length === 1);

    expect(expiry.errors[0]).toBeInstanceOf(PauseExpiredError);
    expect((expiry.errors[0] as PauseExpiredError).cause).toBeUndefined();
  });

  test("AC1: no expiresIn and no run deadline: it never expires", async ({ app, clock }) => {
    const paused = await execute(app, PlainWorkflowStart, ORDER, THREAD);
    expect(paused.pending[0]?.expiresAt).toBeUndefined();

    await clock.advance(hours(24 * 400));

    expect(expiry.errors).toHaveLength(0);
    const [pause] = await expiryStore().findAllByTenantIdAndRootExecutionId(
      "default",
      paused.executionId,
    );
    expect(pause?.status).toBe(PauseStatus.Pending);
  });
});

describe("#941 AC2: the channel decides on expiry", () => {
  test("AC2: decide: the step goes on with the answer, recorded as answered by the expiry; the channel heard closed expired with the masked answer", async ({
    app,
    clock,
  }) => {
    expiry.behavior = () =>
      PauseExpiration.decide({ approved: true, comment: "auto-approved: small amount" });
    const paused = await execute(app, ShortExpiryWorkflowStart, ORDER, THREAD);

    await clock.advance(hours(4));
    await until(() => expiry.ended.length === 1);

    expect(expiry.recorded).toEqual(["o-1: approved (auto-approved: small amount)"]);
    expect(expiry.asked).toHaveLength(1);
    expect(expiry.resumes).toMatchObject([
      {
        reason: ResumeReason.Expired,
        decision: { approved: true, comment: "auto-approved: small amount" },
        answeredBy: undefined,
      },
    ]);
    const [pause] = await expiryStore().findAllByTenantIdAndRootExecutionId(
      "default",
      paused.executionId,
    );
    expect(pause).toMatchObject({
      status: PauseStatus.Taken,
      resolution: PauseResolution.DecidedOnExpiry,
    });
    await until(() => expiry.closed.length === 1);
    expect(expiry.closed[0]).toMatchObject({
      reason: "expired",
      answer: { approved: true, comment: "auto-approved: small amount" },
    });
    expect(expiry.closed[0]?.answeredBy).toBeUndefined();
  });

  const fallbacks: readonly (readonly [string, () => unknown, ExpiryProblem])[] = [
    [
      "throws",
      () => Promise.reject(new Error("boom secret@example.com")),
      ExpiryProblem.HandlerFailed,
    ],
    ["gives garbage", () => ({ kind: "maybe" }), ExpiryProblem.HandlerFailed],
    [
      "decides an invalid answer",
      () => PauseExpiration.decide({ approved: "yes" }),
      ExpiryProblem.AnswerInvalid,
    ],
  ];
  for (const [what, behavior, problem] of fallbacks) {
    test(`AC2: the handler ${what}: the expiry fails with ExpiryHandlerError(${problem}); warned without its message`, async ({
      app,
      clock,
    }) => {
      expiry.behavior = behavior as never;
      await execute(app, ShortExpiryWorkflowStart, ORDER, THREAD);

      await clock.advance(hours(4));
      await until(() => expiry.errors.length === 1);

      const [error] = expiry.errors;
      expect(error).toBeInstanceOf(PauseExpiredError);
      const cause = (error as PauseExpiredError).cause;
      expect(cause).toBeInstanceOf(ExpiryHandlerError);
      expect(cause).toMatchObject({ code: "pause.expiry-handler", problem });
      const warnings = logged.filter((entry) => entry.code === "pause.expiry-handler-failed");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain(problem);
      expect(warnings[0]?.message).not.toContain("boom");
      expect(warnings[0]?.message).not.toContain("example.com");
    });
  }

  test("AC2: the handler hangs: cut off at the tool's timeout (30 s), the expiry fails (handler-timeout)", async ({
    app,
    clock,
  }) => {
    expiry.behavior = () => new Promise<never>(() => undefined);
    await execute(app, ShortExpiryWorkflowStart, ORDER, THREAD);

    await clock.advance(hours(4));
    await until(() => expiry.asked.length === 1);
    await clock.advance(seconds(31));
    await until(() => expiry.errors.length === 1);

    expect((expiry.errors[0] as PauseExpiredError).cause).toMatchObject({
      problem: ExpiryProblem.HandlerTimeout,
    });
  });
});

describe("#941 (#933's scope note): the shipped toQuestion starters take expiresIn", () => {
  const edge = testWith(PublicExpiryApplication);

  edge(
    ".toQuestion(Manager, { expiresIn }).onError(PauseExpiredError, toQuestion(Director, { expiresIn })…): the manager's pause expires, the director is asked with his own deadline, the answer goes on the path",
    async ({ app, clock }) => {
      const paused = await execute(app, PublicExpiryWorkflowStart, ORDER, THREAD);
      expect(paused.pending[0]?.expiresAt).toBe(AT(clock, hours(4)));

      await clock.advance(hours(4));
      await until(() => expiry.directorAsked.length === 1);
      const [director] = await expiryStore().findAllByTenantIdAndRootExecutionId(
        "default",
        paused.executionId,
      );
      const open = (
        await expiryStore().findAllByTenantIdAndRootExecutionId("default", paused.executionId)
      ).at(-1);
      expect(director?.resolution).toBe(PauseResolution.Expired);
      expect(open?.expiresAt).toBe(AT(clock, hours(1)));
      const done = await app.resume(
        { pauseId: expiry.directorAsked[0]?.pauseId ?? "", decision: { approved: true } },
        { answeredBy: "director-1" },
      );

      expect(done.status).toBe(ExecutionStatus.Finished);
      expect(expiry.recorded).toEqual(["o-1: escalated, approved"]);
    },
  );

  edge(
    "the director's own deadline: nobody answers him either, the run fails with PauseExpiredError",
    async ({ app, clock }) => {
      await execute(app, PublicExpiryWorkflowStart, ORDER, THREAD);
      await clock.advance(hours(4));
      await until(() => expiry.directorAsked.length === 1);

      await clock.advance(hours(1));
      await until(() => expiry.errors.length === 1);

      expect(expiry.errors[0]).toMatchObject({
        code: "step.pause-expired",
        step: "expiring-director-question",
      });
    },
  );
});
