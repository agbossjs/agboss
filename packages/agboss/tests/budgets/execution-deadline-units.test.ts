import { LimitError } from "../../src/core/error-families/limit-errors.js";
import { usd } from "../../src/units/index.js";
/**
 * #1356 — an execution's deadline (#398 PR 2) on its own: when it is fixed, when it has passed, which of
 * two delays counts and what the error of a passed one says.
 */
import { describe, expect, it } from "vitest";
import {
  checkDeadline,
  deadlineFrom,
  earliestOf,
  withExecutionDeadline,
} from "../../src/budgets/execution-deadline.js";
import { recordToolCost } from "../../src/finops/usage.js";
import type { Milliseconds } from "../../src/units/index.js";

const NOW = new Date("2026-11-20T10:00:00.000Z");
const place = { path: ["start", "pay"], spentUsd: usd(1.5), usage: [recordToolCost("pay", 1.5)] };

describe("#1356: the deadline of a new execution", () => {
  it("is none without a delay, or with one that is no finite number", () => {
    expect(deadlineFrom(NOW, undefined)).toBeUndefined();
    expect(deadlineFrom(NOW, Number.NaN)).toBeUndefined();
    expect(deadlineFrom(NOW, Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(deadlineFrom(NOW, Number.NEGATIVE_INFINITY)).toBeUndefined();
  });

  it("passes after the delay, rounded to a millisecond, never before now", () => {
    expect(deadlineFrom(NOW, 30_000)).toEqual({ at: "2026-11-20T10:00:30.000Z", deadline: 30_000 });
    expect(deadlineFrom(NOW, 1_500.6)).toEqual({ at: "2026-11-20T10:00:01.501Z", deadline: 1_501 });
    expect(deadlineFrom(NOW, -5)).toEqual({ at: NOW.toISOString(), deadline: 0 });
    expect(deadlineFrom(NOW, 0)).toEqual({ at: NOW.toISOString(), deadline: 0 });
  });
});

describe("#1356: a deadline that has passed", () => {
  const deadline = { at: "2026-11-20T10:00:30.000Z", deadline: 30_000 as Milliseconds };

  it("does not stop an execution without one, nor before it, and stops it at the moment", () => {
    expect(() => {
      checkDeadline(undefined, NOW, place);
    }).not.toThrow();
    expect(() => {
      checkDeadline(deadline, new Date("2026-11-20T10:00:29.999Z"), place);
    }).not.toThrow();
    expect(() => {
      checkDeadline(deadline, new Date("2026-11-20T10:00:30.000Z"), place);
    }).toThrow(LimitError.Deadline);
    expect(() => {
      checkDeadline(deadline, new Date("2026-11-20T10:01:00.000Z"), place);
    }).toThrow(LimitError.Deadline);
  });

  it("fails with the deadline, where it passed and what the execution had spent", () => {
    let caught: unknown;
    try {
      checkDeadline(deadline, new Date("2026-11-20T10:01:00.000Z"), place);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LimitError.Deadline);
    expect(caught).toBeInstanceOf(LimitError);
    if (!(caught instanceof LimitError.Deadline)) throw new Error("not the deadline's error");
    expect(caught.name).toBe("LimitError.Deadline");
    expect(caught.code).toBe("limit.deadline");
    expect(caught.key).toBe("deadline");
    expect(caught.limit).toBe(30_000);
    expect(caught.actual).toBe(30_000);
    expect(caught.deadline).toBe(30_000);
    expect(caught.deadlineAt).toBe("2026-11-20T10:00:30.000Z");
    expect(caught.path).toEqual(["start", "pay"]);
    expect(caught.spentUsd).toBe(1.5);
    expect(caught.usage).toEqual(place.usage);
    expect(caught.message).toBe(
      "the execution ran past its deadline of 30 s (at 2026-11-20T10:00:30.000Z)",
    );
    expect(caught.details).toMatchObject({
      key: "deadline",
      limit: 30_000,
      actual: 30_000,
      deadline: 30_000,
      deadlineAt: "2026-11-20T10:00:30.000Z",
    });
  });

  it("keeps the cause it is given, and no usage when it has none", () => {
    const cause = new Error("slow store");
    const error = new LimitError.Deadline({
      deadline: 1_500 as Milliseconds,
      deadlineAt: "2026-11-20T10:00:01.500Z",
      path: ["start"],
      spentUsd: usd(0),
      cause,
    });

    expect(error.cause).toBe(cause);
    expect(error.usage).toEqual([]);
    expect(error.message).toBe(
      "the execution ran past its deadline of 1.5 s (at 2026-11-20T10:00:01.500Z)",
    );
  });
});

describe("#1356: the smaller of two delays", () => {
  it("is the one that is there, or the smaller of both", () => {
    expect(earliestOf(undefined, undefined)).toBeUndefined();
    expect(earliestOf(5, undefined)).toBe(5);
    expect(earliestOf(undefined, 7)).toBe(7);
    expect(earliestOf(5, 7)).toBe(5);
    expect(earliestOf(7, 5)).toBe(5);
    expect(earliestOf(0, 5)).toBe(0);
  });
});

describe("#1356: the context values of an execution with its deadline", () => {
  it("are as they are without one, and the same values plus it with one", () => {
    const values = { tenantId: "acme" };
    const deadline = { at: "2026-11-20T10:00:30.000Z", deadline: 30_000 as Milliseconds };

    expect(withExecutionDeadline(values, undefined)).toBe(values);
    expect(withExecutionDeadline(values, deadline)).toEqual({ tenantId: "acme", deadline });
    expect(values).toEqual({ tenantId: "acme" });
  });
});
