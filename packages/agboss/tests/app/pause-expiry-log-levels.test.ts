/**
 * #1074: an outcome that is correct behaviour is no warning. A run that fails after its pause
 * expired — its run deadline reached, an uncaught `fail()` of the expiry — ended as its record
 * says, and the observers heard it: the expiry did its job, so `pause.expiry-failed` is not logged.
 * It stays for a real failure of the expiry machinery (the store the look reads from).
 */
import { StepError } from "../../src/core/error-families/step-errors.js";
import { LimitError } from "../../src/core/error-families/limit-errors.js";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { testWith } from "../../src/testing/index.js";
import { hours, minutes } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { logged, resetLogged } from "../helpers/log.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  ExpiryApplication,
  ExpiryWorkflowStart,
  ReviewerWorkflowStart,
  ShortExpiryWorkflowStart,
  SlowExpiryWorkflowStart,
  expiry,
  expiryStore,
  resetExpiry,
} from "../flow/fixtures/expiry.fixture.js";
import { ExecutionLeaseLostError } from "../../src/index.js";
import { PauseExpiration } from "../../src/channels/pause-expiration.js";
import { seconds } from "../../src/units/index.js";
import { settle } from "./fixtures/fence-takeover.js";
import { ExecutionRecordRepository } from "../../src/infrastructure/execution-record.repository.js";

const test = testWith(ExpiryApplication);
const EXPIRY_FAILED = "pause.expiry-failed";

beforeEach(() => {
  resetExpiry();
  resetLogged();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("#1074: a run's own end after an expiry is not a warning", () => {
  test("the run deadline reached after the expiry: the run fails with LimitError.Deadline, nothing is warned", async ({
    app,
    clock,
  }) => {
    await execute(
      app,
      ExpiryWorkflowStart,
      { orderId: "o-1" },
      { threadId: "log-1", deadline: minutes(5) },
    );

    await clock.advance(minutes(6));
    await until(() => expiry.errors.length === 1);

    expect(expiry.errors[0]).toBeInstanceOf(LimitError.Deadline);
    expect(logged.filter((entry) => entry.code === EXPIRY_FAILED)).toEqual([]);
  });

  test("an uncaught fail() of the expiry (no .onError): the run fails with StepError.PauseExpired, nothing is warned", async ({
    app,
    clock,
  }) => {
    await execute(app, ReviewerWorkflowStart, { orderId: "o-1" }, { threadId: "log-2" });

    await clock.advance(hours(1));
    await until(() => expiry.errors.length === 1);

    expect(expiry.errors[0]).toBeInstanceOf(StepError.PauseExpired);
    expect(logged.filter((entry) => entry.code === EXPIRY_FAILED)).toEqual([]);
    expect(logged.filter((entry) => entry.code.startsWith("pause."))).toEqual([]);
  });

  test("a real failure of the expiry machinery (the root's record cannot be read) is still a warning, once per look", async ({
    app,
    clock,
  }) => {
    await execute(app, ReviewerWorkflowStart, { orderId: "o-1" }, { threadId: "log-3" });
    const records = app.resolve(ExecutionRecordRepository);
    vi.spyOn(records, "findByTenantIdAndRunId").mockRejectedValue(new Error("the store is down"));
    expect(expiryStore()).toBeDefined();

    await clock.advance(hours(1));
    await until(() => logged.some((entry) => entry.code === EXPIRY_FAILED));

    const [entry] = logged.filter((one) => one.code === EXPIRY_FAILED);
    expect(entry).toMatchObject({ level: "warn" });
    expect(entry?.message).toContain("the store is down");
  });

  test("a store failure inside the run the expiry continues (its record cannot be read back) is still a warning", async ({
    app,
    clock,
  }) => {
    await execute(app, ShortExpiryWorkflowStart, { orderId: "o-1" }, { threadId: "log-4" });
    const records = app.resolve(ExecutionRecordRepository);
    // the handler asks first; from then on the store fails, as the continued run starts
    expiry.behavior = () => {
      vi.spyOn(records, "byIds").mockRejectedValue(new Error("the store went down mid-run"));
      return PauseExpiration.fail();
    };

    await clock.advance(hours(4));
    await until(() => logged.some((entry) => entry.code === EXPIRY_FAILED));

    const [entry] = logged.filter((one) => one.code === EXPIRY_FAILED);
    expect(entry).toMatchObject({ level: "warn" });
  });

  test("a run handed over after its expiry (its lease lost while the escalation runs) is not a warning: the next holder continues it", async ({
    app,
    clock,
    leases,
  }) => {
    await app.ready();
    await execute(app, SlowExpiryWorkflowStart, { orderId: "o-1" }, { threadId: "log-5" });
    await clock.advance(seconds(5));
    await until(() => expiry.slowStarted.length === 1);

    // the holder stalls past its lease's expiry while the 30 s step runs, and wakes without it
    leases.freeze(app);
    await clock.advance(seconds(60));
    leases.thaw(app);
    await settle();
    await clock.advance(seconds(5));
    await settle();

    expect(expiry.errors.some((error) => error instanceof ExecutionLeaseLostError)).toBe(false);
    expect(logged.filter((entry) => entry.code === EXPIRY_FAILED)).toEqual([]);
  });
});
