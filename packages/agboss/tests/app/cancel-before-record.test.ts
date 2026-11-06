/**
 * #807 (A2A P1, design §4.1.5, §4.3.2): a cancel request saved in a tree before its execution
 * started — the reserved id of an A2A task cancelled before its run's record exists — is honoured
 * before any step or model call (the watch reads it at the run's first checkpoint write, its
 * renewal check): the call rejects as cancelled, the end is observed once and the record is failed
 * as cancelled — the durable trace a task's read repair finds. Verifies design §4.3.2's assumption.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { ExecutionTreeRepository } from "../../src/infrastructure/execution-tree.repository.js";
import { CANCEL_REQUEST_KEY } from "../../src/app/cancel-requests.js";
import { testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  OrderWorkflowStart,
  RecoveryApplication,
  resetRecovery,
  seen,
  stores,
} from "../infrastructure/fixtures/recovery.workflow.js";

const test = testWith(RecoveryApplication);
const THREAD = "t-1";

beforeEach(resetRecovery);

describe("#807 AC2: a cancel saved before the execution's record exists", () => {
  test("is honoured before any step or model call: cancelled, observed once, the record failed", async ({
    app,
  }) => {
    // unscripted: a model call would fail the test (an unscripted agent)
    await app.ready();
    // the id the run mints next (`SequentialIdGenerator`)
    await app
      .resolve(ExecutionTreeRepository)
      .saveIfAbsentInTree(
        { tenantId: "default", rootExecutionId: "execution-1" },
        CANCEL_REQUEST_KEY,
        {
          requestedAt: "2026-01-01T00:00:00.000Z",
          ownerId: null,
        },
      );

    const call = execute(app, OrderWorkflowStart, { text: "step" }, { threadId: THREAD });

    await expect(call).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(seen.steps).toEqual([]);
    expect(seen.errors.map((error) => error.constructor)).toEqual([ExecutionCancelledError]);
    // the request goes with the tree's keys
    expect(
      await app
        .resolve(ExecutionTreeRepository)
        .findByIdInTree(
          { tenantId: "default", rootExecutionId: "execution-1" },
          CANCEL_REQUEST_KEY,
        ),
    ).toBeUndefined();
    const records = (await stores.records?.lastTerns("default", THREAD, 5)) ?? [];
    expect(records.map(({ runId, status, stopReason }) => ({ runId, status, stopReason }))).toEqual(
      [{ runId: "execution-1", status: "failed", stopReason: `thread "${THREAD}" was cancelled` }],
    );
  });
});
