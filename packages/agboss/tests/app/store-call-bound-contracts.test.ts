/**
 * #928 AC2 — the other contracts' unknown outcomes, reconciled: a call whose answer never comes may
 * have taken effect, and what is done next (a retry, a resend, the sweep) finds the store as it is
 * and moves it once. Each case lets the real store apply the call and then never answers.
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import {
  ExecutionCancelFencedError,
  PauseClosedError,
  PauseStatus,
  StoreCallTimeoutError,
} from "../../src/index.js";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { STORE_CALL_BOUND } from "../../src/app/lease-fence.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { answerOf, execute } from "../helpers/flow.js";
import { until } from "../helpers/until.js";
import { passLive } from "../helpers/live-time.js";
import {
  Charge,
  Clerk,
  LeaseApplication,
  OrderWorkflowStart,
  ReceiptDto,
  resetLease,
  seen,
} from "../infrastructure/fixtures/lease.workflow.js";
import { databaseOf } from "./fixtures/finished-work.js";
import { rejectionOf } from "./fixtures/fence-takeover.js";
import {
  frozenRuns,
  gates,
  letAllGo,
  resetFencedEffect,
} from "./fixtures/fenced-effect.workflow.js";
import {
  CancelFenceApplication,
  FenceChargeStart,
  resetSeen,
  seen as fenced,
} from "./fixtures/cancel-fence.workflow.js";
import { appliedThenSilent, outcomeOf } from "./fixtures/bound-stubs.js";

beforeEach(() => {
  resetLease();
  resetSeen();
  resetFencedEffect();
});

afterEach(() => {
  letAllGo();
  vi.restoreAllMocks();
});

const leased = testWith(LeaseApplication);

describe("#928 AC2: a pause resolve from the answer API", () => {
  leased(
    "AC2: unanswered: store.call-timeout; the retry finds it resolved; the tree resumes once",
    async ({ app, clock, mockLlm }) => {
      mockLlm(Clerk).thenReturn(
        callTool(Charge, { text: "10 USD" }),
        replyWith(ReceiptDto, { text: "Done." }),
      );
      const paused = await execute(app, OrderWorkflowStart, { text: "go" }, { threadId: "t-1" });
      const resolve = appliedThenSilent(
        vi.spyOn(InMemoryPausedExecutionRepository.prototype, "resolveByTenantIdAndPauseId"),
      );

      const first = outcomeOf(app.resume(answerOf(paused, { approved: true })));
      await until(() => resolve.mock.calls.length >= 1, "the answer reached the store");
      await clock.advance(STORE_CALL_BOUND);
      const error = await first;

      expect(error).toBeInstanceOf(StoreCallTimeoutError);
      expect(error).toMatchObject({
        code: "store.call-timeout",
        operation: "resolveByTenantIdAndPauseId",
      });
      const pauses = app.resolve(PausedExecutionRepository);
      const [pause] = await pauses.findAllByTenantIdAndRootExecutionId(
        "default",
        paused.executionId,
      );
      expect(pause?.status).toBe(PauseStatus.Resolved);

      // the retry reads the pause: it is no longer pending, its answer was recorded
      await expect(app.resume(answerOf(paused, { approved: true }))).rejects.toBeInstanceOf(
        PauseClosedError,
      );
      // the tree was marked running before the answer: the recovery sweep resumes it, once
      await passLive(clock, seconds(90));
      await until(() => seen.charges.length > 0, "the tree resumed");
      await passLive(clock, seconds(60));
      expect(seen.charges).toEqual(["10 USD"]);
    },
  );
});

const fence = testWith(CancelFenceApplication, { instances: 2 });

describe("#928 AC2: requestCancel", () => {
  fence(
    "AC2: unanswered: app.cancel rejects; the retry writes the mark once; the next fenced write is refused ExecutionCancelFencedError",
    async ({ apps }) => {
      const [first, second] = apps;
      if (first === undefined || second === undefined) throw new Error("two instances");
      await first.ready();
      await second.ready();
      gates.before = 1;
      const call = execute(first, FenceChargeStart, { text: "order-1" }, { threadId: "t-2" });
      const moving = rejectionOf(call);
      await frozenRuns(1);
      const mark = appliedThenSilent(
        vi.spyOn(InMemoryExecutionLeaseRepository.prototype, "requestCancel"),
      );

      const unanswered = outcomeOf(first.cancel("t-2"));
      await until(() => mark.mock.calls.length >= 1, "the mark reached the store");
      await first.clock.advance(STORE_CALL_BOUND);
      const error = await unanswered;

      expect(error).toBeInstanceOf(StoreCallTimeoutError);
      expect(error).toMatchObject({ operation: "requestCancel", code: "store.call-timeout" });
      const [written] = [...databaseOf(first).cancelRequests.values()];
      // the retry (another instance): the mark is there, written again as it is
      expect(await second.cancel("t-2")).toEqual({ cancelled: true });
      expect([...databaseOf(first).cancelRequests.values()]).toEqual([written]);

      letAllGo();
      const ended = await moving;
      expect(ended).toBeInstanceOf(ExecutionCancelledError);
      expect(fenced.refusals).toHaveLength(1);
      expect(fenced.refusals[0]).toBeInstanceOf(ExecutionCancelFencedError);
      expect(fenced.charged).toEqual([]);
    },
  );
});
