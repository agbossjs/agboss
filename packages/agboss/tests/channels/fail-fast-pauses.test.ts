/**
 * #267 AC10: a `FailFast` failure cancels its launch, paused siblings too — their pauses are
 * withdrawn (`Cancelled`), the tree goes on to the join instead of waiting, and a late answer gets
 * `NotPausedError`; a join's deadline counts elapsed time, pauses included (#279:
 * `tests/flow/runtime/quorum-deadline.test.ts`).
 */
import { beforeEach, describe, expect } from "vitest";
import { NotPausedError, PauseStatus } from "../../src/index.js";
import { AgentFailedError } from "../../src/graph/errors.js";
import { callTool, failWith, ModelFailure, testWith, waitFor } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  AuditCheckAgent,
  AuditRefundAgent,
  AuditWorkflowStart,
  pauseStore,
  PausesApplication,
  RefundTool,
  resetPauses,
  seen,
} from "./fixtures/pauses.workflow.js";
import { answerFor, askFor, manager, until } from "./fixtures/pause-scripts.js";

const test = testWith(PausesApplication);

beforeEach(resetPauses);

describe("#267 AC10: FailFast drops the paused siblings' pauses", () => {
  test("a sibling fails after a branch paused: the pause is withdrawn, the execution fails with the sibling's error", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(AuditRefundAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
    mockLlm(AuditCheckAgent).thenReturn(waitFor(seconds(5)), failWith(ModelFailure.Timeout));
    const run = execute(app, AuditWorkflowStart, { orderId: "7" });
    run.catch(() => undefined);
    await until(() => seen.asks.length === 1);

    await clock.advance(seconds(5));

    // the join runs in the pass that took the withdrawal: the sibling's own error object, kept
    await expect(run).rejects.toBeInstanceOf(AgentFailedError);
    await expect(run).rejects.toMatchObject({ agent: "audit-check-agent" });
    const stored = await pauseStore().findByTenantIdAndPauseId("default", askFor("7").pauseId);
    expect(stored?.status).toBe(PauseStatus.Cancelled);
    expect(seen.pauses).toEqual([]);
    await expect(app.resume(answerFor("7"), manager)).rejects.toBeInstanceOf(NotPausedError);
    expect(seen.refunds).toEqual([]);
  });
});
