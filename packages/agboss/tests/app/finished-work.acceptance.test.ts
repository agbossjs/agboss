/**
 * #520 acceptance — the stale take of finished work, past the handoff's tests:
 *
 * - the finish never landed (a store whose `finish` is a release — a crash between the queue's
 *   completion and the finish, or a holder that lost its lease): A's frozen reclaim is then given
 *   the free lease, and only the look after the store (`LeaseTake.isOver`) stops it — no takeover,
 *   nothing runs twice, the lease given back at once;
 * - the root's window the handoff admits (a root's lease is never finished): the sweep's frozen ask
 *   is given the lease of a root that finished meanwhile — given back at once, no takeover row, no
 *   `execution.recovered`, no second start or run;
 * - a compensated child (it booked, then failed): A's frozen reclaim takes nothing, the booking ran
 *   once on B and its undo once, in the parent's node on A.
 */
import { beforeEach, describe, expect } from "vitest";
import {
  ApplicationContext,
  ChildExecutionFailedError,
  Clock,
  ExecutionLeaseRepository,
  ExecutionRecordStatus,
  Injectable,
} from "../../src/index.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import {
  IN_MEMORY_DATABASE,
  type ExecutionLeaseRow,
} from "../../src/infrastructure/in-memory-database.js";
import type { ExecutionLease } from "../../src/infrastructure/execution-lease.repository.js";
import { override, testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { passLive } from "../helpers/live-time.js";
import { logged, resetLogged } from "../helpers/log.js";
import { until } from "../helpers/until.js";
import { rejectionOf, settle } from "./fixtures/fence-takeover.js";
import {
  bothReady,
  childOf,
  item,
  leaseRowOf,
  statusOf,
  takeoversOf,
} from "./fixtures/finished-work.js";
import {
  FinishedUndoApplication,
  resetUndo,
  UndoOneWorkflowStart,
  undoSeen,
} from "./fixtures/finished-undo.workflow.js";
import {
  openGate,
  RemoteChildYieldApplication,
  resetYield,
  YieldCheckedWorkflowFinish,
  YieldCheckWorkflowStart,
  YieldOneWorkflowFinish,
  YieldOneWorkflowStart,
  yieldSeen,
} from "./fixtures/remote-child-yield.workflow.js";

/** A lease store whose finish never lands as one: the key is only released, free to any take. */
@Injectable({ deps: [Clock, ApplicationContext, IN_MEMORY_DATABASE] })
class UnfinishedLeases extends InMemoryExecutionLeaseRepository {
  override finish(lease: ExecutionLease): Promise<void> {
    return this.release(lease);
  }
}

const unfinished = testWith(RemoteChildYieldApplication, {
  instances: 2,
  overrides: [override(ExecutionLeaseRepository, UnfinishedLeases)],
});
const sweep = testWith(RemoteChildYieldApplication, { instances: 2 });
const compensated = testWith(FinishedUndoApplication, { instances: 2 });

/** The executions of `workflow` that started, by the observer's log. */
const startsOf = (workflow: string): readonly string[] =>
  yieldSeen.starts.filter((line) => line.startsWith(`${workflow} `));

/** The lease row is given back, not held: released, at `leaseEpoch`. */
const expectGivenBack = (row: ExecutionLeaseRow | undefined, leaseEpoch: number): void => {
  expect(row).toMatchObject({ released: true, lease: { leaseEpoch } });
};

beforeEach(() => {
  resetYield();
  resetUndo();
  resetLogged();
});

describe("#520 acceptance: the finish never landed — the look after the store stops the stale take", () => {
  unfinished(
    "A's reclaim, frozen while B answers the child, is given the free lease: it gives it back at once, writes no takeover, and the child ran once",
    async ({ apps, clock, leases }) => {
      const [a, b] = await bothReady(apps);
      const call = execute(a, YieldOneWorkflowStart, item("gate"), { threadId: "thread-a" });
      await until(() => yieldSeen.runs.length === 1, "the child at its gate on B");
      const child = childOf(b);
      leases.stall(a);
      await clock.advance(seconds(1));
      await settle();

      openGate();
      await until(
        () => statusOf(b, child) === ExecutionRecordStatus.Answered,
        "the child answered on B",
      );
      // B's finish was only a release: the key is free to A's frozen ask
      expect(leaseRowOf(b, child.executionId)?.isFinished).toBeUndefined();
      leases.resume(a);
      const done = await call;
      await settle();

      expect(done).toFinishWith(YieldOneWorkflowFinish, { name: "gate" });
      // A was given epoch 2 and gave it back at once: the window was taken, and closed
      expectGivenBack(leaseRowOf(b, child.executionId), 2);
      expect(await takeoversOf(b, child.rootExecutionId, child.executionId)).toEqual([]);
      expect(yieldSeen.runs).toEqual([{ name: "gate", instanceId: "instance-1" }]);
      expect(startsOf("yield-check-workflow")).toHaveLength(1);
    },
  );
});

describe("#520 acceptance: the root's window — the sweep's ask given the lease of a root that finished", () => {
  sweep(
    "the lease goes back at once: no takeover row, nothing logged, no second start, run or end",
    async ({ apps, clock, leases }) => {
      const [a, b] = await bothReady(apps);
      const call = execute(a, YieldCheckWorkflowStart, item("gate"));
      await until(() => yieldSeen.runs.length === 1, "the root's step at its gate on A");
      leases.stall(b);
      // A is live meanwhile: its renewals reach the store in time (#534)
      await passLive(clock, seconds(30));
      await settle();

      openGate();
      const done = await call;
      leases.resume(b);
      await settle();
      await passLive(clock, seconds(30));
      await settle();

      expect(done).toFinishWith(YieldCheckedWorkflowFinish, { name: "gate" });
      // B's frozen ask was given epoch 2 once A released epoch 1, and gave it back unused
      expectGivenBack(leaseRowOf(b, done.executionId), 2);
      expect(await takeoversOf(b, done.executionId, done.executionId)).toEqual([]);
      expect(logged.map((entry) => entry.code)).not.toContain("execution.recovered");
      expect(yieldSeen.runs).toEqual([{ name: "gate", instanceId: "instance-2" }]);
      expect(startsOf("yield-check-workflow")).toHaveLength(1);
      expect(yieldSeen.ends.filter((line) => line.startsWith("yield-check-workflow "))).toEqual([
        `yield-check-workflow ${done.executionId}`,
      ]);
    },
  );
});

describe("#520 acceptance: a compensated child — undone, then failed — is not taken again", () => {
  compensated(
    "A's reclaim, frozen while B's child books and fails, takes nothing: the booking ran once on B, its undo once on A",
    async ({ apps, clock, leases }) => {
      const [a, b] = await bothReady(apps);
      const call = execute(a, UndoOneWorkflowStart, item("gate", "fail"), { threadId: "thread-a" });
      await until(() => yieldSeen.runs.length === 1, "the child at its gate on B");
      const child = childOf(b);
      leases.stall(a);
      await clock.advance(seconds(1));
      await settle();

      openGate();
      await until(
        () => statusOf(b, child) === ExecutionRecordStatus.Failed,
        "the child failed on B",
      );
      leases.resume(a);
      const error = await rejectionOf(call);
      await settle();

      // B: the instance the child ran on; A: its parent's, which undoes the failed child's
      // booking in its node once it reclaimed its own lease (#340 PR 3)
      const onB = yieldSeen.runs[0]?.instanceId ?? "";
      const onA = onB === "instance-1" ? "instance-2" : "instance-1";
      expect(error).toBeInstanceOf(ChildExecutionFailedError);
      expect(leaseRowOf(b, child.executionId)).toMatchObject({
        released: true,
        isFinished: true,
        lease: { holderInstanceId: onB, leaseEpoch: 1 },
      });
      expect(await takeoversOf(b, child.rootExecutionId, child.executionId)).toEqual([]);
      expect(undoSeen.booked).toEqual([`booking-gate on ${onB}`]);
      expect(undoSeen.cancelled).toEqual([`booking-gate on ${onA}`]);
      expect(yieldSeen.runs).toEqual([{ name: "gate", instanceId: onB }]);
    },
  );
});
