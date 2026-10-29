import { expect } from "vitest";
import type { ChildExecutionQueueRepository } from "../../infrastructure/child-execution-queue.repository.js";
import { ExecutionRecordStatus } from "../../infrastructure/execution-record.repository.js";
import type { ContractCase } from "./define.js";
import { queuedChild as child } from "./queued-child.js";

/** #333 PR 4: a queued child comes back to the queue when its run must go on elsewhere. */
export const QUEUE_REQUEUE_CASE: ContractCase<ChildExecutionQueueRepository> = {
  name: "a paused child or a running claim whose worker lost its lease can be queued again (#333 PR 4)",
  run: async ({ first, second }) => {
    await first.saveIfAbsent(child("c-1"));
    const claimed = await first.claimFirstByStatusQueuedOrderByDepthDesc();
    expect(claimed?.claimedAt).toBeDefined();

    // another claimAt does not overwrite a running row; the matching claimAt re-queues it
    expect(await second.saveIfAbsent(child("c-1", { claimedAt: new Date(0) }))).toBe(false);
    expect(await second.saveIfAbsent(child("c-1", { claimedAt: claimed?.claimedAt }))).toBe(true);
    const reclaimed = await second.claimFirstByStatusQueuedOrderByDepthDesc();
    expect(reclaimed).toMatchObject({
      executionId: "c-1",
      status: ExecutionRecordStatus.Running,
      instanceId: "instance-2",
    });

    // completed as Paused, then re-queued on resume with the updated run payload
    expect(
      await second.completeByTenantIdAndExecutionId("default", "c-1", {
        status: ExecutionRecordStatus.Paused,
      }),
    ).toBe(true);
    expect(await first.saveIfAbsent(child("c-1", { run: '{"resume":{"i":"p"}}' }))).toBe(true);
    expect(await first.findByTenantIdAndExecutionId("default", "c-1")).toMatchObject({
      status: ExecutionRecordStatus.Queued,
      run: '{"resume":{"i":"p"}}',
      instanceId: undefined,
    });
  },
};
