/** #194: errors are kept as plain records; `catchError` matches records by code, after JSON too. */
import { describe, expect, it } from "vitest";
import { codeOfErrorClass, errorRecordOf, recordMatches } from "../../src/core/error-record.js";
import {
  AgentFailedError,
  BudgetExceededError,
  BudgetScope,
  LimitExceededError,
  PaidStepError,
  WorkflowCancelledError,
} from "../../src/index.js";

import { usd } from "../../src/units/index.js";

class FlightApiDown extends Error {}
class BookingError extends Error {
  static readonly code: string = "booking";
}
class CodedUserError extends BookingError {
  static override readonly code: string = "booking.flight";
}

const budget = new BudgetExceededError(
  {
    budget: { name: "shop-execution-budget" },
    scope: BudgetScope.Execution,
    key: "run-1",
    maxSpend: usd(0.01),
    spent: usd(0.02),
  },
  ["order", "buyer"],
  0.02,
);

/** What a serialising checkpointer gives back. */
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("#194: error records", () => {
  it("a record is plain JSON with the class code, the details and the cause chain", () => {
    const agent = new AgentFailedError("buyer", [], new FlightApiDown("down"));

    expect(roundTrip(errorRecordOf(budget))).toEqual({
      name: "BudgetExceededError",
      code: "limit.budget",
      lineage: ["limit.budget", "limit", "agboss"],
      message: budget.message,
      details: {
        key: "run-1",
        limit: 0.01,
        actual: 0.02,
        budget: { name: "shop-execution-budget" },
        scope: "execution",
        maxSpend: 0.01,
        spent: 0.02,
      },
    });
    expect(roundTrip(errorRecordOf(agent))).toMatchObject({
      code: "step.agent",
      details: { agent: "buyer" },
      cause: { name: "Error", code: "FlightApiDown", message: "down" },
    });
    expect(errorRecordOf("boom")).toEqual({
      name: "Error",
      code: "Error",
      lineage: ["Error"],
      message: "boom",
    });
  });

  it("matches by code after a JSON round trip: the class, its parents, its causes", () => {
    const record = roundTrip(errorRecordOf(budget));
    const wrapped = roundTrip(errorRecordOf(new AgentFailedError("buyer", [], budget)));

    expect(recordMatches(record, codeOfErrorClass(BudgetExceededError))).toBe(true);
    expect(recordMatches(record, codeOfErrorClass(LimitExceededError))).toBe(true);
    expect(recordMatches(record, codeOfErrorClass(Error))).toBe(true);
    expect(recordMatches(record, codeOfErrorClass(WorkflowCancelledError))).toBe(false);
    expect(recordMatches(wrapped, codeOfErrorClass(BudgetExceededError))).toBe(true);
    expect(recordMatches(wrapped, codeOfErrorClass(PaidStepError))).toBe(true);
  });

  it("a user error class matches by its static code, else by its name; its parents' codes too", () => {
    expect(codeOfErrorClass(CodedUserError)).toBe("booking.flight");
    expect(codeOfErrorClass(FlightApiDown)).toBe("FlightApiDown");
    expect(recordMatches(errorRecordOf(new CodedUserError("x")), "booking")).toBe(true);
    expect(recordMatches(errorRecordOf(new BookingError("x")), "booking.flight")).toBe(false);
    expect(recordMatches(errorRecordOf(new FlightApiDown("x")), "FlightApiDown")).toBe(true);
  });
});
