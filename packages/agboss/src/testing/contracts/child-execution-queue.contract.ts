import { expect } from "vitest";
import type {
  ChildExecutionQueueRepository,
  QueuedChildExecution,
} from "../../infrastructure/child-execution-queue.repository.js";
import { ExecutionRecordStatus } from "../../infrastructure/execution-record.repository.js";
import { seconds } from "../../units/index.js";
import { pingOf, registerContract, type ContractCase } from "./define.js";
import { QUEUE_REQUEUE_CASE } from "./child-execution-queue-requeue.case.js";
import { QUEUE_DEPTH_CASES } from "./child-execution-queue-depth.cases.js";
import { QUEUE_WATCH_CASES } from "./child-execution-queue-watch.cases.js";
import { nulCaseName, NUL_TEXT } from "./nul-text.js";
import { queuedChild as child } from "./queued-child.js";
import type { ContractTarget } from "./instance-context.js";

/** The queued child `c-1`, failed by its claimer. */
const FAILED = { status: ExecutionRecordStatus.Failed, failure: '{"name":"E"}' } as const;

const claimNext = (
  queue: ChildExecutionQueueRepository,
): Promise<QueuedChildExecution | undefined> => queue.claimFirstByStatusQueuedOrderByDepthDesc();

const QUEUE_CASES: readonly ContractCase<ChildExecutionQueueRepository>[] = [
  {
    name: "a child is queued once",
    run: async ({ first, second }) => {
      const saved = await Promise.all([
        first.saveIfAbsent(child("c-1")),
        second.saveIfAbsent(child("c-1")),
      ]);

      expect(saved.sort()).toEqual([false, true]);
      expect(await second.findByTenantIdAndExecutionId("default", "c-1")).toMatchObject({
        status: ExecutionRecordStatus.Queued,
        rootWorkflow: "items-workflow",
        depth: 2,
      });
    },
  },
  {
    name: "claimed once: of two instances one gets it, with its id and time",
    run: async ({ clock, first, second }) => {
      await first.saveIfAbsent(child("c-1"));
      await clock.advance(seconds(5));

      const claims = await Promise.all([claimNext(first), claimNext(second)]);

      const claimed = claims.filter((found) => found !== undefined);
      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({
        status: ExecutionRecordStatus.Running,
        claimedAt: new Date("2026-01-05T09:00:05Z"),
      });
      expect(["instance-1", "instance-2"]).toContain(claimed[0]?.instanceId);
    },
  },
  {
    // #720: a claim that marked a row it did not answer leaves that child `Running` for an
    // instance that never heard of it — no pass runs it, and only a reclaim can save it
    name: "a claim marks exactly the child it answers: every other stays queued",
    run: async ({ first, second }) => {
      const ids = ["c-1", "c-2", "c-3", "c-4", "c-5", "c-6"];
      for (const id of ids) await first.saveIfAbsent(child(id));

      const claims = await Promise.all([first, second, first, second].map(claimNext));

      const answered = claims.flatMap((found) => (found === undefined ? [] : [found.executionId]));
      expect(answered).toHaveLength(4);
      const rows = await Promise.all(
        ids.map((id) => second.findByTenantIdAndExecutionId("default", id)),
      );
      const running = rows.filter((row) => row?.status === ExecutionRecordStatus.Running);
      expect(running.map((row) => row?.executionId).sort()).toEqual([...answered].sort());
      expect(rows.filter((row) => row?.status === ExecutionRecordStatus.Queued)).toHaveLength(2);
    },
  },
  {
    name: "the deepest first, then the longest waiting",
    run: async ({ first }) => {
      await first.saveIfAbsent(child("late", { queuedAt: new Date("2026-01-05T09:00:02Z") }));
      await first.saveIfAbsent(child("early", { queuedAt: new Date("2026-01-05T09:00:01Z") }));
      await first.saveIfAbsent(
        child("deep", { depth: 3, queuedAt: new Date("2026-01-05T09:00:03Z") }),
      );

      const order: (string | undefined)[] = [];
      for (let claim = 0; claim < 4; claim += 1) order.push((await claimNext(first))?.executionId);

      expect(order).toEqual(["deep", "early", "late", undefined]);
    },
  },
  {
    name: "only its claimer completes it, once",
    run: async ({ first, second }) => {
      await first.saveIfAbsent(child("c-1"));
      await claimNext(first);

      expect(await second.completeByTenantIdAndExecutionId("default", "c-1", FAILED)).toBe(false);
      expect(await first.completeByTenantIdAndExecutionId("default", "c-1", FAILED)).toBe(true);
      expect(await first.completeByTenantIdAndExecutionId("default", "c-1", FAILED)).toBe(false);
      expect(await second.findByTenantIdAndExecutionId("default", "c-1")).toMatchObject({
        status: ExecutionRecordStatus.Failed,
        failure: '{"name":"E"}',
        instanceId: "instance-1",
      });
    },
  },
  {
    name: "a tree's rows go with its root; another tree's and tenant's stay",
    run: async ({ first, second }) => {
      await first.saveIfAbsent(child("c-1"));
      await first.saveIfAbsent(child("c-2", { rootExecutionId: "root-2" }));
      await first.saveIfAbsent(child("c-3", { tenantId: "acme" }));

      await second.deleteAllByTenantIdAndRootExecutionId("default", "root-1");

      expect(await first.findByTenantIdAndExecutionId("default", "c-1")).toBeUndefined();
      expect(await first.findByTenantIdAndExecutionId("default", "c-2")).toBeDefined();
      expect(await first.findByTenantIdAndExecutionId("acme", "c-3")).toBeDefined();
    },
  },
  QUEUE_REQUEUE_CASE,
  {
    name: nulCaseName("a child's run and its failure"),
    run: async ({ first, second }) => {
      const run = JSON.stringify({ input: { text: NUL_TEXT } });
      const failure = JSON.stringify({ name: "E", message: NUL_TEXT });
      await first.saveIfAbsent(child("c-1", { run }));
      await claimNext(first);

      await first.completeByTenantIdAndExecutionId("default", "c-1", {
        status: ExecutionRecordStatus.Failed,
        failure,
      });

      expect(await second.findByTenantIdAndExecutionId("default", "c-1")).toMatchObject({
        run,
        failure,
      });
    },
  },
];

/**
 * `ChildExecutionQueueRepository` (#333 PR 2): a child is queued once and claimed once (of two
 * instances exactly one gets it), the deepest first, then the longest waiting; only its claimer
 * completes it; a tree's rows go with its root; a paused child or a lost claim is queued again;
 * its depth (#485) counts every queued and running row once, with the oldest still queued; a
 * store's watch (#777, optional) wakes an instance when any instance queues a child.
 */
export function childExecutionQueueContract(
  target: ContractTarget<ChildExecutionQueueRepository>,
): void {
  const cases = [...QUEUE_CASES, ...QUEUE_DEPTH_CASES, ...QUEUE_WATCH_CASES];
  registerContract("child execution queue contract", target, [{ cases }], pingOf);
}
