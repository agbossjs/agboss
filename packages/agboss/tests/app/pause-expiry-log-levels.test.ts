/**
 * #1074: an outcome that is correct behaviour is no warning. A run that fails after its pause
 * expired — its run deadline reached, an uncaught `fail()` of the expiry — ended as its record
 * says, and the observers heard it: the expiry did its job, so `pause.expiry-failed` is not logged.
 * It stays for a real failure of the expiry machinery (the store the look reads from).
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { DeadlineExceededError } from "../../src/budgets/execution-deadline.js";
import { PauseExpiredError } from "../../src/flow/runtime/pause-expired-error.js";
import { testWith } from "../../src/testing/index.js";
import { hours, minutes } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { logged, resetLogged } from "../helpers/log.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  ExpiryApplication,
  ExpiryWorkflowStart,
  ReviewerWorkflowStart,
  expiry,
  expiryStore,
  resetExpiry,
} from "../flow/fixtures/expiry.fixture.js";
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
  test("the run deadline reached after the expiry: the run fails with DeadlineExceededError, nothing is warned", async ({
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

    expect(expiry.errors[0]).toBeInstanceOf(DeadlineExceededError);
    expect(logged.filter((entry) => entry.code === EXPIRY_FAILED)).toEqual([]);
  });

  test("an uncaught fail() of the expiry (no .onError): the run fails with PauseExpiredError, nothing is warned", async ({
    app,
    clock,
  }) => {
    await execute(app, ReviewerWorkflowStart, { orderId: "o-1" }, { threadId: "log-2" });

    await clock.advance(hours(1));
    await until(() => expiry.errors.length === 1);

    expect(expiry.errors[0]).toBeInstanceOf(PauseExpiredError);
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
});
