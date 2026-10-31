/**
 * #598 — a failure's durable record and the failure rebuilt from it: the record of the rebuilt one
 * is the original's (its class line by code, its causes; no details), at the same depth wherever it
 * is made, so `.onError` routes it as the original on every instance; what is no record rebuilds the
 * way it did before, the same on every instance.
 */
import { describe, expect, it } from "vitest";
import {
  codeOfErrorClass,
  errorMatchOf,
  errorRecordOf,
  MAX_ERROR_CAUSES,
  RecordedError,
  durableErrorOf,
  errorRecordFromDurable,
  recordedErrorOf,
  type ErrorRecord,
} from "../../src/core/error-record.js";
import {
  AGBossError,
  BudgetExceededError,
  BudgetScope,
  ChildExecutionFailedError,
  ExecutionCancelledError,
  StepFailedError,
} from "../../src/index.js";
import { ActionFailedError } from "../../src/flow/runtime/errors.js";
import { CompensationFailedError, CompensationReason } from "../../src/flow/compensation.js";
import {
  causeOfMark,
  unwindingMarkOf,
} from "../../src/flow/runtime/compensation/unwinding-marks.js";
import {
  remoteFailureOf,
  RemoteChildFailure,
} from "../../src/flow/runtime/remote/remote-failure.js";
import { usd } from "../../src/units/index.js";
import { childFailureOf, type EndedChild } from "../../src/flow/runtime/child-exit.js";

class PaymentDeclinedError extends Error {
  override name = "PaymentDeclinedError";
}
class CardError extends AGBossError {
  static override readonly code: string = "card";
}
class CardExpiredError extends CardError {
  static override readonly code: string = "card.expired";
}

/** The record without its details, everywhere in the chain: what a store keeps. */
function withoutDetails(record: ErrorRecord): ErrorRecord {
  const { details: _details, cause, ...rest } = record;
  return cause === undefined ? rest : { ...rest, cause: withoutDetails(cause) };
}

/** Through a store: JSON text and back. */
const stored = (thrown: unknown): RecordedError | undefined =>
  recordedErrorOf(JSON.parse(JSON.stringify(durableErrorOf(thrown))));

const child = {
  executionId: "execution-2",
  workflow: { name: "pay-workflow", version: "1.0.0", startedVersion: "1.0.0", configHash: "h" },
};

const declined = new ActionFailedError("charge-action", new PaymentDeclinedError("declined"));

describe("#598: a failure rebuilt from its durable record routes as the original", () => {
  it("the rebuilt failure's record is the original's, its details left out", () => {
    const original = new CardExpiredError("expired", {
      cause: declined,
      details: { last4: "4242" },
    });
    const rebuilt = stored(original);

    expect(rebuilt).toBeInstanceOf(RecordedError);
    expect(errorRecordOf(rebuilt)).toEqual(withoutDetails(errorRecordOf(original)));
    expect(rebuilt?.name).toBe("CardExpiredError");
    expect(rebuilt?.message).toBe("expired");
    // a framework error's own `code` is kept; a project's plain Error has none
    expect(rebuilt?.code).toBe("card.expired");
    expect(stored(new PaymentDeclinedError("x"))?.code).toBeUndefined();
  });

  it("wrapped again on another instance, every side path's class matches it as the original", () => {
    const classes = [StepFailedError, PaymentDeclinedError, CardError, CardExpiredError, Error];
    for (const failure of [declined, new CardExpiredError("x"), new Error("plain")]) {
      const here = errorRecordOf(new ChildExecutionFailedError(child, failure, []));
      const there = errorRecordOf(new ChildExecutionFailedError(child, stored(failure), []));
      // errorHandlerOf ranks the side paths by these matches: the same matches, the same path
      for (const errorClass of classes) {
        const code = codeOfErrorClass(errorClass);
        expect(errorMatchOf(there, code)).toEqual(errorMatchOf(here, code));
      }
    }
  });

  it("a cause chain that loops ends at its first repeat, here and there alike", () => {
    const looping = new Error("a");
    Object.defineProperty(looping, "cause", { value: new Error("b", { cause: looping }) });

    const record = errorRecordOf(looping);

    expect(record.cause?.message).toBe("b");
    expect(record.cause?.cause).toBeUndefined();
    expect(errorRecordOf(stored(looping))).toEqual(record);
  });

  it(`a chain deeper than ${String(MAX_ERROR_CAUSES)} is cut at the same depth, rebuilt inside a wrapper or not`, () => {
    let deep: Error = new PaymentDeclinedError("bottom");
    for (let level = 0; level < MAX_ERROR_CAUSES + 8; level += 1)
      deep = new Error(`level ${String(level)}`, { cause: deep });
    const depthOf = (record: ErrorRecord | undefined): number =>
      record === undefined ? -1 : 1 + depthOf(record.cause);

    const here = errorRecordOf(new Error("wrapper", { cause: deep }));
    const there = errorRecordOf(new Error("wrapper", { cause: stored(deep) }));

    expect(depthOf(here)).toBe(MAX_ERROR_CAUSES);
    expect(there).toEqual(here);
  });

  it("what is no record is undefined: a broken value, a broken cause, a pre-#598 row", () => {
    for (const value of [undefined, null, "text", 42, [], {}, { name: "E", message: "m" }])
      expect(errorRecordFromDurable(value)).toBeUndefined();
    const broken = { ...durableErrorOf(declined), cause: { name: 1 } };
    expect(errorRecordFromDurable(broken)).toBeUndefined();
    expect(errorRecordFromDurable({ ...durableErrorOf(declined), lineage: [] })).toBeUndefined();
  });
});

describe("#598: what a store holds, as each reader rebuilds it", () => {
  it("an undo's mark keeps the record: a failure rebuilt as RecordedError, a cancel as a cancel", () => {
    expect(causeOfMark(unwindingMarkOf(declined))).toBeInstanceOf(RecordedError);
    expect(withoutDetails(errorRecordOf(causeOfMark(unwindingMarkOf(declined))))).toEqual(
      withoutDetails(errorRecordOf(declined)),
    );
    const cancelled = causeOfMark(unwindingMarkOf(new ExecutionCancelledError("stop")));
    expect(cancelled).toBeInstanceOf(ExecutionCancelledError);
  });

  it("a mark written before #598 (no record) is an AGBossError with the message on every instance", () => {
    const legacy = {
      reason: CompensationReason.ExecutionFailed,
      cause: { name: "X", message: "m" },
    };
    const rebuilt = causeOfMark(legacy);

    expect(rebuilt).toBeInstanceOf(AGBossError);
    expect(errorRecordOf(rebuilt).lineage).toEqual(["agboss"]);
  });

  it("a remote child's row keeps the record; a row written before #598 is RemoteChildFailure", () => {
    const row = JSON.stringify(durableErrorOf(declined));
    const legacy = JSON.stringify({ name: "PaymentDeclinedError", message: "declined" });

    expect(errorRecordOf(remoteFailureOf(row))).toEqual(withoutDetails(errorRecordOf(declined)));
    expect(remoteFailureOf(legacy)).toBeInstanceOf(RemoteChildFailure);
    expect(errorRecordOf(remoteFailureOf(legacy)).lineage).toEqual(["RemoteChildFailure"]);
  });

  it("a rebuilt budget's or failed undo's error keeps its class line: it passes a child's boundary as it is", () => {
    const budget = new BudgetExceededError(
      {
        budget: { name: "b" },
        scope: BudgetScope.Tenant,
        key: "acme",
        maxSpend: usd(1),
        spent: usd(2),
      },
      [],
      2,
    );
    const undo = new CompensationFailedError([], declined);

    expect(stored(budget)?.record.lineage).toContain(BudgetExceededError.code);
    expect(stored(undo)?.record.lineage).toContain(CompensationFailedError.code);
  });

  it("rebuilt, a budget's and a failed undo's error pass the child's boundary as they are; any other is wrapped", () => {
    const ended: EndedChild = {
      identity: {
        executionId: "execution-2",
        parentExecutionId: "execution-1",
        rootExecutionId: "execution-1",
        inheritedUsage: 0,
      },
      depth: 2,
      workflow: child.workflow,
      launchedBy: { nodeId: "pay-workflow", visitNumber: 1 },
      start: "pay-workflow-start",
      input: {},
      records: { components: new Map(), graph: { nodes: new Map() } },
    };
    const through = (error: unknown) =>
      childFailureOf(error, ended, [], new AbortController().signal).thrown;
    const budget = stored(
      new BudgetExceededError(
        {
          budget: { name: "b" },
          scope: BudgetScope.Tenant,
          key: "acme",
          maxSpend: usd(1),
          spent: usd(2),
        },
        [],
        2,
      ),
    );
    const undo = stored(new CompensationFailedError([], declined));

    expect(through(budget)).toBe(budget);
    expect(through(undo)).toBe(undo);
    expect(through(stored(declined))).toBeInstanceOf(ChildExecutionFailedError);
  });
});
