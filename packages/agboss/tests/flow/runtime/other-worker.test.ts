import { beforeEach, describe, expect } from "vitest";
import { ApplicationContext, ChildExecutionQueueRepository } from "../../../src/index.js";
import { ExecutionRecordStatus } from "../../../src/infrastructure/execution-record.repository.js";
import { remoteChildSignals } from "../../../src/flow/runtime/remote/remote-child-signals.js";
import type { TestApp } from "../../../src/testing/test-app.js";
import { settle } from "../../app/fixtures/fence-takeover.js";
import { testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import { seconds } from "../../../src/units/index.js";
import { first, untilSettled } from "../../metrics/support/runs.js";
import {
  OtherWorkerApplication,
  OtherWorkerItemWorkflowFinish,
  OtherWorkerRootWorkflowStart,
  OtherWorkerUnavailableWorkflowFinish,
  otherLog,
} from "./fixtures/other-worker.workflow.js";

/** #1286 / D9: `ChildPlacement.OtherWorker` never runs on the launching instance. */

const item = { name: "a", delay: 0, outcome: "ok" };

beforeEach(() => {
  otherLog.ranOn = [];
});

describe("#1286 D9: OtherWorker with no other live worker", () => {
  const alone = testWith(OtherWorkerApplication);

  alone(
    "the parent's step fails with StepError.ChildWorkerUnavailable after childClaimTimeout; the child never ran here",
    async ({ apps, clock }) => {
      const app = first(apps);
      const call = execute(app, OtherWorkerRootWorkflowStart, item);

      await untilSettled(call, clock);

      expect(await call).toFinishWith(OtherWorkerUnavailableWorkflowFinish, item);
      expect(otherLog.ranOn).toEqual([]);
    },
  );
});

describe("#1286: OtherWorker with another worker", () => {
  const two = testWith(OtherWorkerApplication, { instances: 2 });

  two(
    "the other instance claims it and runs it; the launcher never does",
    async ({ apps, clock }) => {
      const [a, b] = apps;
      if (a === undefined || b === undefined) throw new Error("two instances");
      await b.ready();
      await a.ready();
      const call = execute(a, OtherWorkerRootWorkflowStart, item);

      await untilSettled(call, clock);

      expect(await call).toFinishWith(OtherWorkerItemWorkflowFinish, { name: "a" });
      expect(otherLog.ranOn).toHaveLength(1);
      expect(otherLog.ranOn[0]).not.toBe(a.resolve(ApplicationContext).instanceId);
      expect(otherLog.ranOn[0]).toBe(b.resolve(ApplicationContext).instanceId);
    },
  );
});

/** `app`'s claims answer nothing until `release()`: the worker is there but has not looked yet. */
function heldClaims(app: TestApp): { readonly release: () => void } {
  const queue = app.resolve(ChildExecutionQueueRepository);
  const claim = queue.claimFirstByStatusQueuedOrderByDepthDesc.bind(queue);
  let isReleased = false;
  queue.claimFirstByStatusQueuedOrderByDepthDesc = () =>
    isReleased ? claim() : Promise.resolve(undefined);
  return {
    release: () => {
      isReleased = true;
    },
  };
}

describe("#1286a: the claim timeout withdraws the queued child", () => {
  const two = testWith(OtherWorkerApplication, { instances: 2 });

  two(
    "a timed-out child is withdrawn and never runs later, even when its tree's rows are not removed",
    async ({ apps, clock }) => {
      const [a, b] = apps;
      if (a === undefined || b === undefined) throw new Error("two instances");
      await b.ready();
      await a.ready();
      const held = heldClaims(b);
      const queue = a.resolve(ChildExecutionQueueRepository);
      // the end of the tree would remove the row: only the withdrawal may do it here
      queue.deleteAllByTenantIdAndRootExecutionId = () => Promise.resolve();
      const withdrawn: boolean[] = [];
      const withdraw = queue.withdrawByTenantIdAndExecutionIdIfQueued.bind(queue);
      queue.withdrawByTenantIdAndExecutionIdIfQueued = async (tenantId, executionId) => {
        const isWithdrawn = await withdraw(tenantId, executionId);
        withdrawn.push(isWithdrawn);
        return isWithdrawn;
      };
      const call = execute(a, OtherWorkerRootWorkflowStart, item);

      await untilSettled(call, clock);

      expect(await call).toFinishWith(OtherWorkerUnavailableWorkflowFinish, item);
      expect(withdrawn).toEqual([true]);
      held.release();
      remoteChildSignals.queued();
      await settle();
      await clock.advance(seconds(60));
      await settle();
      expect(otherLog.ranOn).toEqual([]);
      expect(
        await b.resolve(ChildExecutionQueueRepository).claimFirstByStatusQueuedOrderByDepthDesc(),
      ).toBeUndefined();
    },
  );

  two(
    "a claim that wins the race with the timeout keeps the parent waiting; the child runs once",
    async ({ apps, clock }) => {
      const [a, b] = apps;
      if (a === undefined || b === undefined) throw new Error("two instances");
      await b.ready();
      await a.ready();
      const held = heldClaims(b);
      const queue = a.resolve(ChildExecutionQueueRepository);
      const withdraw = queue.withdrawByTenantIdAndExecutionIdIfQueued.bind(queue);
      const attempts: boolean[] = [];
      queue.withdrawByTenantIdAndExecutionIdIfQueued = async (tenantId, executionId) => {
        // the worker claims the row just before the parent's withdrawal reaches the queue
        held.release();
        remoteChildSignals.queued();
        for (let turn = 0; turn < 200; turn += 1) {
          const row = await queue.findByTenantIdAndExecutionId(tenantId, executionId);
          if (row?.status !== ExecutionRecordStatus.Queued) break;
          await settle();
        }
        const isWithdrawn = await withdraw(tenantId, executionId);
        attempts.push(isWithdrawn);
        return isWithdrawn;
      };
      const call = execute(a, OtherWorkerRootWorkflowStart, item);

      await untilSettled(call, clock);

      expect(attempts).toEqual([false]);
      expect(await call).toFinishWith(OtherWorkerItemWorkflowFinish, { name: "a" });
      expect(otherLog.ranOn).toEqual([b.resolve(ApplicationContext).instanceId]);
    },
  );
});
