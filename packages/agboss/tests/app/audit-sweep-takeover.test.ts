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

describe("the idle-thread sweep takes the audit rows of its trees with it", () => {
  it("the rows of a swept thread's ended tree are removed, a tree of a kept thread keeps its own", async () => {
    const { clock, auditLog, sources, takeoverRow } = setup();
    const records = new Map<string, ExecutionRecordStatus>([
      ["root-1", ExecutionRecordStatus.Answered],
      ["root-2", ExecutionRecordStatus.Running],
    ]);
    await auditLog.save(takeoverRow(2));
    await auditLog.save({ ...takeoverRow(2), rootExecutionId: "root-2", executionId: "root-2" });
    await clock.advance(seconds(5));
    const threadRecords = {
      findByTenantIdAndRunId: (_tenant: string, runId: string) => {
        const status = records.get(runId);
        return Promise.resolve(status === undefined ? undefined : ({ status } as never));
      },
      // the store removes a thread only when all its trees ended; here the root-1 thread
      deleteIdleThreads: async (
        _cutoffs: ReadonlyMap<string, Date>,
        isEnded: (tree: { tenantId: string; rootExecutionId: string }) => Promise<boolean>,
      ) => {
        let removed = 0;
        for (const id of ["root-1", "root-2"])
          if (await isEnded({ tenantId: "default", rootExecutionId: id })) {
            records.delete(id);
            removed += 1;
          }
        return removed;
      },
    };

    const swept = await removeExpired(
      {
        ...sources,
        auditLogRetention: hours(24),
        threadRecords,
        threadTtls: new Map([["w", hours(1)]]),
      },
      () => undefined,
    );

    expect(swept.find((one) => one.what === "the idle memory threads")?.removed).toBe(1);
    expect(
      await auditLog.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt("default", "root-1"),
    ).toEqual([]);
    expect(
      await auditLog.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt("default", "root-2"),
    ).toHaveLength(1);
  });

  it("a failing audit store between the thread's removal and its rows' removal loses no rows: a later look removes them (#1410 M2)", async () => {
    const { clock, auditLog, sources, takeoverRow } = setup();
    const records = new Map<string, ExecutionRecordStatus>([
      ["root-1", ExecutionRecordStatus.Answered],
    ]);
    await auditLog.save(takeoverRow(2));
    await clock.advance(seconds(5));
    const threadRecords = {
      findByTenantIdAndRunId: (_tenant: string, runId: string) => {
        const status = records.get(runId);
        return Promise.resolve(status === undefined ? undefined : ({ status } as never));
      },
      deleteIdleThreads: async (
        _cutoffs: ReadonlyMap<string, Date>,
        isEnded: (tree: { tenantId: string; rootExecutionId: string }) => Promise<boolean>,
      ) => {
        if (!(await isEnded({ tenantId: "default", rootExecutionId: "root-1" }))) return 0;
        records.delete("root-1");
        return 1;
      },
    };
    let failures = 1; // the idle sweep's own call (a cutoff past now), not the audit expiry's
    const flaky = Object.create(auditLog) as typeof auditLog;
    flaky.deleteExpired = (cutoff, isEnded) => {
      if (cutoff.getTime() > clock.now().getTime() && failures-- > 0)
        return Promise.reject(new Error("audit store down"));
      return auditLog.deleteExpired(cutoff, isEnded);
    };
    const flakySources = {
      ...sources,
      auditLog: flaky,
      auditLogRetention: hours(1),
      treeRecords: threadRecords,
      threadRecords,
      threadTtls: new Map([["w", hours(1)]]),
    };
    const reported: unknown[] = [];

    await removeExpired(flakySources, (failure) => reported.push(failure));

    expect(reported).toHaveLength(1); // the record is gone, the rows are left behind
    const rowsOf = () =>
      auditLog.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt("default", "root-1");
    expect(await rowsOf()).toHaveLength(1);

    // a recent row of a missing record is not swept yet: nothing is removed on a guess
    await clock.advance(hours(2));
    await removeExpired(flakySources, () => undefined);
    expect(await rowsOf()).toHaveLength(1);

    await clock.advance(hours(24));
    await removeExpired(flakySources, () => undefined);
    expect(await rowsOf()).toEqual([]);
  });

  it("a tree with no record is not ended for the idle sweep: its thread is kept", async () => {
    const { sources } = setup();
    const asked: boolean[] = [];
    const threadRecords = {
      findByTenantIdAndRunId: () => Promise.resolve(undefined),
      deleteIdleThreads: async (
        _cutoffs: ReadonlyMap<string, Date>,
        isEnded: (tree: { tenantId: string; rootExecutionId: string }) => Promise<boolean>,
      ) => {
        asked.push(await isEnded({ tenantId: "default", rootExecutionId: "root-9" }));
        return 0;
      },
    };

    await removeExpired(
      { ...sources, threadRecords, threadTtls: new Map([["w", hours(1)]]) },
      () => undefined,
    );

    expect(asked).toEqual([false]);
  });
});
