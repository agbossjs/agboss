/**
 * #1321b on SQLite: the audit log's sweep removes the old rows of the trees that ended, never a row
 * of a tree that is live or paused (a takeover reads them, #853), and asks each tree once.
 */
import { describe, expect, it } from "vitest";
import {
  ExecutionAuditEventKind,
  LeaseTakeoverReason,
  type LeaseTakeoverRecord,
} from "../../../src/infrastructure/execution-audit-log.repository.js";
import { SqliteExecutionAuditLogRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-audit-log.repository.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

const AT = "2026-11-24T10:00:00.000Z";

const takeover = (rootExecutionId: string, tenantId = "default", at = AT): LeaseTakeoverRecord => ({
  kind: ExecutionAuditEventKind.Takeover,
  occurredAt: at,
  tenantId,
  rootExecutionId,
  executionId: rootExecutionId,
  scopeKey: `${tenantId}:${rootExecutionId}`,
  token: 2,
  holderInstanceId: "instance-2",
  reason: LeaseTakeoverReason.Recovered,
});

describe("#1321b: the SQLite audit log's sweep", () => {
  it("removes the old rows of ended trees only, asks each tree once, and keeps a row at the cutoff", async () => {
    const log = new SqliteExecutionAuditLogRepository(connectionTo(temporarySqlitePath()));
    await log.save(takeover("ended"));
    await log.save(takeover("ended"));
    await log.save(takeover("live"));
    await log.save(takeover("ended", "other"));
    await log.save(takeover("ended", "default", "2026-11-24T10:00:01.000Z"));
    const asked: string[] = [];

    const removed = await log.deleteExpired(new Date("2026-11-24T10:00:01.000Z"), (tree) => {
      asked.push(`${tree.tenantId}/${tree.rootExecutionId}`);
      return Promise.resolve(tree.rootExecutionId === "ended" && tree.tenantId === "default");
    });

    expect(removed).toBe(2);
    expect(asked.sort()).toEqual(["default/ended", "default/live", "other/ended"]);
    const left = async (tenantId: string, root: string) =>
      (await log.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(tenantId, root)).length;
    expect(await left("default", "ended")).toBe(1);
    expect(await left("default", "live")).toBe(1);
    expect(await left("other", "ended")).toBe(1);
  });

  it("a tree that is not ended keeps every row, whatever its age", async () => {
    const log = new SqliteExecutionAuditLogRepository(connectionTo(temporarySqlitePath()));
    await log.save(takeover("live"));

    expect(
      await log.deleteExpired(new Date("2030-01-01T00:00:00.000Z"), () => Promise.resolve(false)),
    ).toBe(0);
    expect(
      await log.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt("default", "live"),
    ).toHaveLength(1);
  });
});
