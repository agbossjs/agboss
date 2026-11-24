import { expect } from "vitest";
import type { ChildExecutionQueueRepository } from "../../infrastructure/child-execution-queue.repository.js";
import { ExecutionRecordStatus } from "../../infrastructure/execution-record.repository.js";
import { ChildPlacement } from "../../flow/child-placement.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import { queuedChild as child } from "./queued-child.js";

/**
 * #1286: the placement of a queued child decides who may claim it. An `OtherWorker` child carries
 * the instance that queued it (`excludeInstanceId`) and that instance's claim skips it — also after
 * a requeue; an `IsolatedWorker` child is never claimed by the general claim; an `AnyWorker` one by
 * whoever comes first.
 */

type Instances = ContractInstances<ChildExecutionQueueRepository>;

const claimNext = (queue: ChildExecutionQueueRepository) =>
  queue.claimFirstByStatusQueuedOrderByDepthDesc();

const other = { placement: ChildPlacement.OtherWorker, excludeInstanceId: "instance-1" } as const;

export const QUEUE_PLACEMENT_CASES: readonly ContractCase<ChildExecutionQueueRepository>[] = [
  {
    name: "the placement and the excluded instance are kept as queued (#1286)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.saveIfAbsent(child("c-1", other));

      expect(await second.findByTenantIdAndExecutionId("default", "c-1")).toMatchObject(other);
    },
  },
  {
    name: "an OtherWorker child is never claimed by the instance that queued it, and is by another (#1286)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.saveIfAbsent(child("c-1", other));

      expect(await claimNext(first)).toBeUndefined();
      expect(await first.findByTenantIdAndExecutionId("default", "c-1")).toMatchObject({
        status: ExecutionRecordStatus.Queued,
      });
      expect(await claimNext(second)).toMatchObject({
        executionId: "c-1",
        status: ExecutionRecordStatus.Running,
        instanceId: "instance-2",
      });
    },
  },
  {
    name: "an excluded row does not hide the next one: the instance claims what it may (#1286)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.saveIfAbsent(child("deep", { ...other, depth: 4 }));
      await first.saveIfAbsent(child("plain", { placement: ChildPlacement.AnyWorker }));

      expect((await claimNext(first))?.executionId).toBe("plain");
      expect(await claimNext(first)).toBeUndefined();
      expect((await claimNext(second))?.executionId).toBe("deep");
    },
  },
  {
    name: "a requeue keeps the exclusion: the paused OtherWorker child is not claimed by its queuer (#1286)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.saveIfAbsent(child("c-1", other));
      await claimNext(second);
      await second.completeByTenantIdAndExecutionId("default", "c-1", {
        status: ExecutionRecordStatus.Paused,
      });

      expect(await first.saveIfAbsent(child("c-1", { ...other, run: '{"resume":{}}' }))).toBe(true);

      expect(await claimNext(first)).toBeUndefined();
      expect(await claimNext(second)).toMatchObject({ executionId: "c-1", run: '{"resume":{}}' });
    },
  },
  {
    name: "an IsolatedWorker child is never claimed by the general claim (#1286)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.saveIfAbsent(child("c-1", { placement: ChildPlacement.IsolatedWorker }));

      expect(await claimNext(first)).toBeUndefined();
      expect(await claimNext(second)).toBeUndefined();
      expect(await first.findByTenantIdAndExecutionId("default", "c-1")).toMatchObject({
        status: ExecutionRecordStatus.Queued,
        placement: ChildPlacement.IsolatedWorker,
      });
    },
  },
  {
    name: "an AnyWorker child is claimed by either instance, once (#1286)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.saveIfAbsent(child("c-1", { placement: ChildPlacement.AnyWorker }));

      const claims = await Promise.all([claimNext(first), claimNext(second)]);

      expect(claims.filter((found) => found !== undefined)).toHaveLength(1);
    },
  },
];
