/**
 * #1321b — the audit log's sweep never removes a row of a tree that is live or paused: a takeover
 * reads the hand-over rows to charge the passes the previous holder lost (#853). A retention of none
 * (`auditLogTtl: Ttl.None`, a cutoff of now) removes the rows at the first sweep after the tree ends.
 */
import { describe, expect, it } from "vitest";
import { lostPassesAtTake } from "../../src/app/lost-passes-at-take.js";
import {
  ExecutionAuditEventKind,
  InMemoryExecutionAuditLogRepository,
  LeaseTakeoverReason,
} from "../../src/infrastructure/execution-audit-log.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { ExecutionRecordStatus } from "../../src/infrastructure/execution-record.repository.js";
import { removeExpired } from "../../src/infrastructure/retention-sweep.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { hours, ms, seconds } from "../../src/units/index.js";

const state = { runId: "root-1", threadId: "th", tenantId: "default", startedVersion: "1" };

/** The root's record, with the status the test sets. */
function recordsOf(status: { current: ExecutionRecordStatus | undefined }) {
  return {
    findByTenantIdAndRunId: () =>
      Promise.resolve(
        status.current === undefined ? undefined : ({ status: status.current } as never),
      ),
  };
}

function setup() {
  const clock = new VirtualClock();
  const auditLog = new InMemoryExecutionAuditLogRepository(new InMemoryDatabase());
  const status: { current: ExecutionRecordStatus | undefined } = {
    current: ExecutionRecordStatus.Running,
  };
  const sources = {
    clock,
    pauses: {
      setAsideStaleNoticesBefore: () => Promise.resolve([]),
      deleteByResolvedAtBefore: () => Promise.resolve(0),
    } as never,
    pauseRecordRetention: hours(1),
    auditLog,
    auditLogRetention: ms(0), // Ttl.None
    treeRecords: recordsOf(status),
  };
  const lostPasses = () =>
    lostPassesAtTake(
      {
        checkpoints: {
          checkpointer: {
            getTuple: () => Promise.resolve({ checkpoint: { id: "c2" }, pendingWrites: [] }),
          },
        },
        auditLog,
        log: { warn: () => undefined } as never,
        workflow: "w",
      },
      state,
    );
  const takeoverRow = (token: number) => ({
    kind: ExecutionAuditEventKind.Takeover as const,
    occurredAt: clock.now().toISOString(),
    tenantId: "default",
    rootExecutionId: "root-1",
    executionId: "root-1",
    scopeKey: "default:root-1",
    token,
    holderInstanceId: "instance-2",
    reason: LeaseTakeoverReason.Recovered,
    previousHolderInstanceId: "instance-1",
    previousToken: token - 1,
    checkpointId: "c2",
  });
  return { clock, auditLog, status, sources, lostPasses, takeoverRow };
}

describe("#1321b: auditLogTtl applies to the rows of trees that ended", () => {
  it("a Ttl.None sweep of a live or paused tree keeps its rows, and a takeover after it still charges the lost passes", async () => {
    const { clock, auditLog, status, sources, lostPasses, takeoverRow } = setup();
    await auditLog.save(takeoverRow(2));
    await clock.advance(seconds(5));

    for (const resting of [
      ExecutionRecordStatus.Running,
      ExecutionRecordStatus.Paused,
      undefined,
    ]) {
      status.current = resting;
      const swept = await removeExpired(sources, () => undefined);
      expect(swept.find((one) => one.what === "the audit log's old rows")?.removed).toBe(0);
    }

    expect(await lostPasses()).toMatchObject({ checkpointId: "c2", tokens: [1] });
  });

  it("once the tree ends, the first sweep removes its rows", async () => {
    const { clock, auditLog, status, sources, lostPasses, takeoverRow } = setup();
    await auditLog.save(takeoverRow(2));
    await clock.advance(seconds(5));

    for (const ended of [
      ExecutionRecordStatus.Answered,
      ExecutionRecordStatus.Failed,
      ExecutionRecordStatus.Guarded,
    ]) {
      await auditLog.save(takeoverRow(3));
      await clock.advance(seconds(1));
      status.current = ended;
      const swept = await removeExpired(sources, () => undefined);
      expect(swept.find((one) => one.what === "the audit log's old rows")?.removed).toBeGreaterThan(
        0,
      );
      expect(
        await auditLog.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt("default", "root-1"),
      ).toEqual([]);
      expect(await lostPasses()).toBeUndefined();
    }
  });

  it("no record source: no audit row is removed", async () => {
    const { clock, auditLog, sources, takeoverRow } = setup();
    await auditLog.save(takeoverRow(2));
    await clock.advance(seconds(5));

    await removeExpired({ ...sources, treeRecords: undefined }, () => undefined);

    expect(
      await auditLog.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt("default", "root-1"),
    ).toHaveLength(1);
  });
});
