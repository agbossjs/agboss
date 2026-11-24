import { expect } from "vitest";
import {
  ExecutionAuditEventKind,
  HandOverReason,
  HandOverSite,
  LeaseTakeoverReason,
  type ExecutionAuditLogRepository,
  type LeaseTakeoverRecord,
  type StepHandedOverRecord,
} from "../../infrastructure/execution-audit-log.repository.js";
import { seconds } from "../../units/index.js";
import type { ContractCase, ContractGroup } from "./define.js";

/**
 * The audit log's sweep (#1321b): it removes the rows older than its cutoff of the trees that ended,
 * and never a row of a tree that is live or paused — a takeover reads them to charge the passes the
 * previous holder lost (#853).
 */

const takeover = (at: string, of: Partial<LeaseTakeoverRecord> = {}): LeaseTakeoverRecord => ({
  kind: ExecutionAuditEventKind.Takeover,
  occurredAt: at,
  tenantId: "default",
  rootExecutionId: "root-1",
  executionId: "root-1",
  scopeKey: "default:root-1",
  token: 2,
  holderInstanceId: "instance-2",
  reason: LeaseTakeoverReason.Recovered,
  ...of,
});

const handedOver = (at: string): StepHandedOverRecord => ({
  kind: ExecutionAuditEventKind.HandedOver,
  occurredAt: at,
  tenantId: "default",
  rootExecutionId: "root-1",
  executionId: "root-1",
  scopeKey: "default:root-1",
  token: 1,
  holderInstanceId: "instance-1",
  reason: HandOverReason.Fenced,
  site: HandOverSite.Tool,
  step: { nodeId: "release-agent", visitNumber: 1, idempotencyKey: "root-1:release-agent:1:c1" },
});

const SWEEP_CASES: readonly ContractCase<ExecutionAuditLogRepository>[] = [
  {
    name: "the sweep never removes a row of a tree that has not ended, whatever its age (1321b)",
    run: async ({ clock, first, second }) => {
      await first.save(handedOver(clock.now().toISOString()));
      await first.save(takeover(clock.now().toISOString()));
      await clock.advance(seconds(60));

      const removed = await second.deleteExpired(clock.now(), () => Promise.resolve(false));

      const found = await first.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
        "default",
        "root-1",
      );
      expect(found.map((row) => row.kind)).toEqual([
        ExecutionAuditEventKind.HandedOver,
        ExecutionAuditEventKind.Takeover,
      ]);
      expect(removed).toBe(0);
    },
  },
  {
    name: "a sweep with a cutoff of now removes an ended tree's rows once it ended, never a live tree's, and asks each tree once (1321b)",
    run: async ({ clock, first, second }) => {
      const at = clock.now().toISOString();
      await first.save(handedOver(at));
      await first.save(takeover(at));
      await first.save(takeover(at, { rootExecutionId: "root-2", scopeKey: "default:root-2" }));
      await first.save(takeover(at, { tenantId: "other", rootExecutionId: "root-1" }));
      await clock.advance(seconds(1));
      const asked: string[] = [];
      const endedRoot2 = (tree: {
        tenantId: string;
        rootExecutionId: string;
      }): Promise<boolean> => {
        asked.push(`${tree.tenantId}/${tree.rootExecutionId}`);
        return Promise.resolve(tree.tenantId === "default" && tree.rootExecutionId === "root-2");
      };

      const removed = await second.deleteExpired(clock.now(), endedRoot2);

      expect(removed).toBe(1);
      expect([...asked].sort()).toEqual(["default/root-1", "default/root-2", "other/root-1"]);
      const root1 = await first.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
        "default",
        "root-1",
      );
      expect(root1).toHaveLength(2);
      const root2 = await first.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
        "default",
        "root-2",
      );
      expect(root2).toEqual([]);
      const other = await first.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
        "other",
        "root-1",
      );
      expect(other).toHaveLength(1);

      // the tree ends: the next sweep removes the rest of its rows
      expect(await second.deleteExpired(clock.now(), () => Promise.resolve(true))).toBe(3);
    },
  },
];

export const auditLogSweepCases = (): ContractGroup<ExecutionAuditLogRepository> => ({
  title: "the sweep of an ended tree's rows",
  cases: SWEEP_CASES,
});
