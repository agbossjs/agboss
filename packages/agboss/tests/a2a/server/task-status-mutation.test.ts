/**
 * #1356 (mutation shard `a2a-tasks`): the tokens a completed task reports, and a recorded error whose
 * original was no framework error.
 */
import { describe, expect, it } from "vitest";
import {
  durableStatusOf,
  failedStatusOf,
  INTERNAL_FAILURE,
} from "../../../src/a2a/tasks/task-status.js";
import { DurableExecutionStatus } from "../../../src/app/execution-control.js";
import { RecordedError } from "../../../src/core/error-record.js";
import { A2ATaskState } from "../../../src/infrastructure/a2a-task.repository.js";
import { usd } from "../../../src/units/index.js";

describe("a completed task's status", () => {
  it("keeps the tokens a finished state spent beside its cost", () => {
    expect(
      durableStatusOf({
        status: DurableExecutionStatus.Finished,
        finish: "f",
        output: { a: 1 },
        spentUsd: usd(0.5),
        spentTokens: 120,
      }),
    ).toStrictEqual({
      state: A2ATaskState.Completed,
      pendingPauses: [],
      finish: "f",
      output: { a: 1 },
      spentUsd: 0.5,
      spentTokens: 120,
    });
  });

  it("has no tokens key when none were counted", () => {
    const status = durableStatusOf({
      status: DurableExecutionStatus.Finished,
      finish: "f",
      output: 1,
      spentUsd: usd(0.5),
    });

    expect(Object.keys(status ?? {})).not.toContain("spentTokens");
  });
});

describe("failedStatusOf: a recorded error's code", () => {
  const record = (lineage: readonly string[], code: string) =>
    new RecordedError({
      name: "Boom",
      code,
      lineage,
      message: "refund to alice@example.com failed",
    });

  it("of a framework original is its own code", () => {
    expect(failedStatusOf(record(["limit.budget", "agboss"], "limit.budget"))).toMatchObject({
      errorCode: "limit.budget",
      message: "the task failed: limit.budget",
    });
  });

  it("of a third-party original is `internal`, whatever code its record holds", () => {
    expect(failedStatusOf(record([], "stripe.card"))).toEqual({
      state: A2ATaskState.Failed,
      pendingPauses: [],
      errorCode: INTERNAL_FAILURE,
      message: "the task failed",
    });
  });
});
