import { PauseError } from "../../../../src/core/error-families/pause-errors.js";
import { usd } from "../../../../src/units/index.js";
/**
 * #1366: how a step whose pause expired fails — a run-bound pause fails with the run's own deadline error (the
 * budgets' check first, any other error it throws goes on as it is), else with PauseExpiredError carrying the
 * pause's expiry problem as its cause; the deadline given is the frame's, else the pause's own wait.
 */
import { describe, expect, it } from "vitest";
import { DeadlineExceededError } from "../../../../src/budgets/execution-deadline.js";
import {
  PauseExpiryBound,
  ExpiryProblem,
  type PauseRecord,
} from "../../../../src/infrastructure/pause-record.js";
import {
  PauseExpirySignal,
  expiryFailureOf,
  type ExpirySite,
} from "../../../../src/flow/runtime/pause-expiry-failure.js";
import { PauseExpiredError } from "../../../../src/flow/runtime/pause-expired-error.js";
import { runInFrame } from "../../../../src/flow/context/frame.js";
import { seconds } from "../../../../src/units/index.js";
import { ComponentKind } from "../../../../src/flow/runtime/records.js";

const ASKED = "2026-01-01T00:00:00.000Z";
const EXPIRES = "2026-01-01T00:00:30.000Z";

const pauseOf = (changes: Partial<PauseRecord> = {}): PauseRecord =>
  ({
    pauseId: "p1",
    channel: "ops",
    kind: "external-task",
    askedAt: ASKED,
    expiresAt: EXPIRES,
    expiryBound: PauseExpiryBound.RunDeadline,
    ...changes,
  }) as never;

const siteOf = (check: ExpirySite["budgets"]["check"] = () => undefined): ExpirySite => ({
  step: "ask-ops",
  stepKind: ComponentKind.Question,
  state: [],
  usage: [],
  path: ["flow", "ask-ops"],
  budgets: { check },
});

/** A frame's execution always carries its signal. */
const { signal } = new AbortController();

const inFrameWithoutDeadline = <T>(work: () => Promise<T>): Promise<T> =>
  runInFrame({ execution: { signal } as never, step: {} as never }, work);

describe("#1366: the signal", () => {
  it("is named and carries its pause", () => {
    const pause = pauseOf();
    const signal = new PauseExpirySignal(pause);

    expect(signal.name).toBe("PauseExpirySignal");
    expect(signal.pause).toBe(pause);
  });
});

describe("#1366: a run-bound pause", () => {
  it("fails with the deadline given by the pause's own wait when no frame says one", () => {
    const error = expiryFailureOf(pauseOf(), siteOf());

    expect(error).toBeInstanceOf(DeadlineExceededError);
    expect((error as DeadlineExceededError).deadline).toBe(30_000);
    expect((error as DeadlineExceededError).deadlineAt).toBe(EXPIRES);
  });

  it("does the same inside a frame whose execution has no deadline", async () => {
    const error = await inFrameWithoutDeadline(() =>
      Promise.resolve(expiryFailureOf(pauseOf(), siteOf())),
    );

    expect(error).toBeInstanceOf(DeadlineExceededError);
    expect((error as DeadlineExceededError).deadline).toBe(30_000);
  });

  it("takes the deadline the frame's execution was given", async () => {
    const execution = { signal, deadline: { deadline: 90_000, at: EXPIRES } } as never;
    const error = await runInFrame({ execution, step: {} as never }, () =>
      Promise.resolve(expiryFailureOf(pauseOf(), siteOf())),
    );

    expect((error as DeadlineExceededError).deadline).toBe(90_000);
  });

  it("returns the deadline error the budgets' check throws", () => {
    const own = new DeadlineExceededError({
      deadline: seconds(1),
      deadlineAt: ASKED,
      path: [],
      spentUsd: usd(0),
    });
    const error = expiryFailureOf(
      pauseOf(),
      siteOf(() => {
        throw own;
      }),
    );

    expect(error).toBe(own);
  });

  it("throws any other error the budgets' check throws", () => {
    const other = new RangeError("budget");

    expect(() =>
      expiryFailureOf(
        pauseOf(),
        siteOf(() => {
          throw other;
        }),
      ),
    ).toThrow(other);
  });
});

describe("#1366: a pause with its own bound", () => {
  it("fails with PauseExpiredError, its expiry problem kept as the cause", () => {
    const pause = pauseOf({
      expiryBound: PauseExpiryBound.Pause,
      boundAt: "2099-01-01T00:00:00.000Z",
      expiryProblem: ExpiryProblem.HandlerFailed,
    });
    const error = expiryFailureOf(pause, siteOf());

    expect(error).toBeInstanceOf(PauseExpiredError);
    expect((error as PauseExpiredError).expiresAt).toBe(EXPIRES);
    expect((error as PauseExpiredError).channel).toBe("ops");
    expect((error as PauseExpiredError).cause).toBeInstanceOf(PauseError.ExpiryHandlerFailed);
    expect(((error as PauseExpiredError).cause as PauseError.ExpiryHandlerFailed).problem).toBe(
      ExpiryProblem.HandlerFailed,
    );
    expect(((error as PauseExpiredError).cause as PauseError.ExpiryHandlerFailed).channel).toBe(
      "ops",
    );
  });

  it("has no cause when it recorded no expiry problem", () => {
    const pause = pauseOf({
      expiryBound: PauseExpiryBound.Pause,
      boundAt: "2099-01-01T00:00:00.000Z",
    });

    expect((expiryFailureOf(pause, siteOf()) as PauseExpiredError).cause).toBeUndefined();
  });
});
