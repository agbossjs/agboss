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
  {
    name: "a queued child is withdrawn once: its row is gone and no instance claims it later (#1286a)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.saveIfAbsent(child("c-1", other));

      expect(await first.withdrawByTenantIdAndExecutionIdIfQueued("default", "c-1")).toBe(true);
      expect(await second.withdrawByTenantIdAndExecutionIdIfQueued("default", "c-1")).toBe(false);

      expect(await first.findByTenantIdAndExecutionId("default", "c-1")).toBeUndefined();
      expect(await claimNext(second)).toBeUndefined();
    },
  },
  {
    name: "a claimed child is not withdrawn: it stays Running for its claimer (#1286a)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.saveIfAbsent(child("c-1", other));
      await claimNext(second);

      expect(await first.withdrawByTenantIdAndExecutionIdIfQueued("default", "c-1")).toBe(false);

      expect(await first.findByTenantIdAndExecutionId("default", "c-1")).toMatchObject({
        status: ExecutionRecordStatus.Running,
        instanceId: "instance-2",
      });
    },
  },
  {
    name: "a claim and a withdrawal of one row never both win (#1286a)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.saveIfAbsent(child("c-1", other));

      const [claimed, withdrawn] = await Promise.all([
        claimNext(second),
        first.withdrawByTenantIdAndExecutionIdIfQueued("default", "c-1"),
      ]);

      expect(claimed !== undefined).toBe(!withdrawn);
    },
  },
  {
    name: "the queued IsolatedWorker children are listed, the deepest first, never the other ones (#1286b)",
    run: async ({ first }: Instances): Promise<void> => {
      const isolated = { placement: ChildPlacement.IsolatedWorker } as const;
      await first.saveIfAbsent(child("shallow", { ...isolated, depth: 2 }));
      await first.saveIfAbsent(child("deep", { ...isolated, depth: 5 }));
      await first.saveIfAbsent(child("plain", { placement: ChildPlacement.AnyWorker, depth: 9 }));

      expect(
        (await first.findQueuedIsolatedWorkerChildren(10)).map((one) => one.executionId),
      ).toEqual(["deep", "shallow"]);
      expect(await first.findQueuedIsolatedWorkerChildren(1)).toHaveLength(1);
    },
  },
  {
    name: "the targeted claim takes an IsolatedWorker child once, for the instance that asks (#1286b)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.saveIfAbsent(child("c-1", { placement: ChildPlacement.IsolatedWorker }));

      const claims = await Promise.all([
        first.claimIsolatedWorkerByTenantIdAndExecutionId("default", "c-1"),
        second.claimIsolatedWorkerByTenantIdAndExecutionId("default", "c-1"),
      ]);

      const claimed = claims.filter((found) => found !== undefined);
      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({
        executionId: "c-1",
        status: ExecutionRecordStatus.Running,
      });
      expect(["instance-1", "instance-2"]).toContain(claimed[0]?.instanceId);
      expect(await first.findQueuedIsolatedWorkerChildren(10)).toEqual([]);
    },
  },
  {
    name: "the targeted claim takes no child but an IsolatedWorker one, and none that is claimed or unknown (#1286b)",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.saveIfAbsent(child("plain", { placement: ChildPlacement.AnyWorker }));
      await first.saveIfAbsent(child("iso", { placement: ChildPlacement.IsolatedWorker }));

      expect(
        await first.claimIsolatedWorkerByTenantIdAndExecutionId("default", "plain"),
      ).toBeUndefined();
      expect(
        await first.claimIsolatedWorkerByTenantIdAndExecutionId("default", "none"),
      ).toBeUndefined();
      expect(
        await first.claimIsolatedWorkerByTenantIdAndExecutionId("default", "iso"),
      ).toBeDefined();
      expect(
        await second.claimIsolatedWorkerByTenantIdAndExecutionId("default", "iso"),
      ).toBeUndefined();
      expect(await first.findByTenantIdAndExecutionId("default", "plain")).toMatchObject({
        status: ExecutionRecordStatus.Queued,
      });
    },
  },
];
