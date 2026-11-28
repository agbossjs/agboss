/**
 * #1366 (ledger-retention shard) — what the recovery sweep removes once a retention is over, each kind on its own:
 * the ledger's old entries (#771) beside the pause records, the mesh answers, the kept executions, the fenced
 * effects, the audit log, the ended outbound calls and the project's own rows; a store that fails is reported
 * and the others are still asked.
 */
import { describe, expect, it, vi } from "vitest";
import { removeExpired, type RetentionSources } from "../../src/infrastructure/retention-sweep.js";
import { pauseKeyOf } from "../../src/infrastructure/pause-record.js";
import { removeClosedPauses } from "../../src/infrastructure/pause-log-repair.js";

vi.mock("../../src/infrastructure/pause-log-repair.js", () => ({ removeClosedPauses: vi.fn() }));

/** A retention in milliseconds (the branded type of the unit helpers has no millisecond one). */
const milliseconds = (amount: number): never => amount as never;

const NOW = new Date("2026-11-21T12:00:00.000Z");
const cutoffOf = (retention: number): Date => new Date(NOW.getTime() - retention);

const store = <TMethod extends string>(method: TMethod) =>
  ({ [method]: vi.fn(() => Promise.resolve(0)) }) as Record<TMethod, ReturnType<typeof vi.fn>>;

/** Every kind of rows, each with its own store and retention. */
const sourcesOf = (changes: Partial<RetentionSources> = {}) => {
  const pauses = {
    deleteByResolvedAtBefore: vi.fn(() => Promise.resolve(0)),
    setAsideStaleNoticesBefore: vi.fn(() => Promise.resolve([])),
  };
  const ledgerOwn = {
    marker: "ledger",
    deleteByMadeAtBefore: vi.fn(function (this: { marker: string }, _cutoff: Date) {
      return Promise.resolve(this.marker === "ledger" ? 1 : 0);
    }),
  };
  const stores = {
    meshRequests: store("deleteExpired"),
    executionHistory: store("deleteExpired"),
    fencedEffects: store("deleteExpired"),
    auditLog: {
      ...store("deleteExpired"),
      findAllByTenantIdAndRootExecutionIdOrderByOccurredAt: vi.fn(() => Promise.resolve([])),
    },
    outboundCalls: store("deleteExpired"),
  };
  /** The root records the audit sweep reads to tell whether a tree ended (#1321b): by default every tree has. */
  const treeRecords = {
    findByTenantIdAndRunId: vi.fn(() => Promise.resolve({ status: "answered" })),
  };
  const sources = {
    clock: { now: () => NOW },
    pauses,
    pauseRecordRetention: milliseconds(1000),
    ...stores,
    treeRecords,
    idempotencyRetention: 2000,
    executionRecordRetention: milliseconds(3000),
    auditLogRetention: milliseconds(5000),
    ledger: ledgerOwn,
    ledgerEntryRetention: milliseconds(7000),
    ...changes,
  };
  return { sources: sources as RetentionSources, pauses, ledgerOwn, stores, treeRecords };
};

const sweep = (sources: RetentionSources) => {
  const report = vi.fn();
  return { report, done: removeExpired(sources, report) };
};

describe("#1366: the sweep removes each kind of rows past its retention", () => {
  it("tells what each look removed: the count of the stores that count, none for the others", async () => {
    const { sources, stores } = sourcesOf();
    stores.meshRequests.deleteExpired.mockResolvedValue(4);

    const swept = await sweep(sources).done;

    expect(swept.find((one) => one.what === "the mesh requests' answers")?.removed).toBe(4);
    expect(swept.find((one) => one.what === "the notices of a receiver no instance knows")).toEqual(
      { what: "the notices of a receiver no instance knows", removed: undefined },
    );
  });

  it("the ledger's entries made before the cut, through the ledger itself", async () => {
    const { sources, ledgerOwn } = sourcesOf();
    const { done, report } = sweep(sources);

    await done;

    expect(ledgerOwn.deleteByMadeAtBefore).toHaveBeenCalledOnce();
    expect(ledgerOwn.deleteByMadeAtBefore).toHaveBeenCalledWith(cutoffOf(7000));
    expect(report).not.toHaveBeenCalled();
  });

  it("every other kind, each at its own cut (the rows with an expiry of their own: due now)", async () => {
    const { sources, pauses, stores } = sourcesOf();

    await sweep(sources).done;

    expect(pauses.deleteByResolvedAtBefore).toHaveBeenCalledWith(cutoffOf(1000));
    expect(stores.meshRequests.deleteExpired).toHaveBeenCalledWith(NOW); // each request keeps its own expiry (#1319c): due now
    expect(stores.executionHistory.deleteExpired).toHaveBeenCalledWith(cutoffOf(3000));
    expect(stores.fencedEffects.deleteExpired).toHaveBeenCalledWith(cutoffOf(0));
    expect(stores.auditLog.deleteExpired).toHaveBeenCalledWith(
      cutoffOf(5000),
      expect.any(Function),
    );
    expect(stores.outboundCalls.deleteExpired).toHaveBeenCalledWith(cutoffOf(0));
  });

  it("the audit log is swept with the question of whether a tree ended, answered by its root's record", async () => {
    const { sources, stores, treeRecords } = sourcesOf();
    const ended = (status: string | undefined) => {
      treeRecords.findByTenantIdAndRunId.mockResolvedValue(
        (status === undefined ? undefined : { status }) as never,
      );
      return sweep(sources).done.then(() => {
        const isEnded = stores.auditLog.deleteExpired.mock.lastCall?.[1] as (tree: {
          tenantId: string;
          rootExecutionId: string;
        }) => Promise<boolean>;
        return isEnded({ tenantId: "tenant-1", rootExecutionId: "root-1" });
      });
    };

    expect(await ended("answered")).toBe(true);
    expect(await ended("failed")).toBe(true);
    expect(await ended("guarded")).toBe(true);
    // a live, a paused and an unknown tree count as live: nothing is removed on a guess
    expect(await ended("running")).toBe(false);
    expect(await ended("paused")).toBe(false);
    // no record and a recent row: a record still racing to be written, live
    const rows = stores.auditLog.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt;
    rows.mockResolvedValue([{ occurredAt: new Date(NOW.getTime() - 1000).toISOString() }] as never);
    expect(await ended(undefined)).toBe(false);
    // no record and every row older than the retention and a day: the idle sweep removed it (#1410 M2)
    rows.mockResolvedValue([
      { occurredAt: new Date(NOW.getTime() - 25 * 3_600_000).toISOString() },
    ] as never);
    expect(await ended(undefined)).toBe(true);
    // a row exactly at the grace's edge is not older than it: still live
    rows.mockResolvedValue([
      { occurredAt: new Date(NOW.getTime() - 24 * 3_600_000).toISOString() },
    ] as never);
    expect(await ended(undefined)).toBe(false);
    // one recent row among old ones: still live
    rows.mockResolvedValue([
      { occurredAt: new Date(NOW.getTime() - 25 * 3_600_000).toISOString() },
      { occurredAt: new Date(NOW.getTime() - 1000).toISOString() },
    ] as never);
    expect(await ended(undefined)).toBe(false);
    expect(treeRecords.findByTenantIdAndRunId).toHaveBeenLastCalledWith("tenant-1", "root-1");
  });

  it("with no records to tell an ended tree by, no audit row is removed", async () => {
    const { sources, stores } = sourcesOf({ treeRecords: undefined });

    await sweep(sources).done;

    expect(stores.auditLog.deleteExpired).not.toHaveBeenCalled();
  });

  it("a pause record's removal writes the lost answers first when there is a log of them", async () => {
    const answers = { name: "answers" };
    const { sources, pauses } = sourcesOf({ answers } as never);

    await sweep(sources).done;

    expect(removeClosedPauses).toHaveBeenCalledWith(pauses, answers, cutoffOf(1000));
    expect(pauses.deleteByResolvedAtBefore).not.toHaveBeenCalled();
  });

  it("the notices of a receiver no instance knows are set aside at the pause retention and reported", async () => {
    const warn = vi.fn();
    const { sources, pauses } = sourcesOf({ log: { warn } } as never);
    pauses.setAsideStaleNoticesBefore.mockResolvedValue([
      { tenantId: "tenant-1", pauseId: "p1", recipient: "slack" },
    ] as never);

    await sweep(sources).done;

    expect(pauses.setAsideStaleNoticesBefore).toHaveBeenCalledWith(
      cutoffOf(1000),
      NOW,
      "recipient-unknown",
      200,
    );
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toBe("pause.notice-recipient-unknown");
    expect(warn.mock.calls[0]?.[2]).toEqual({ tenantId: "tenant-1" });
    expect(warn.mock.calls[0]?.[1]).toBe(
      `the notices of pause ${pauseKeyOf("tenant-1", "p1")} to slack were set aside: no instance knows that receiver`,
    );
  });

  it("with no log the notices are set aside all the same, and nothing is reported", async () => {
    const { sources, pauses } = sourcesOf();
    pauses.setAsideStaleNoticesBefore.mockResolvedValue([
      { tenantId: "tenant-1", pauseId: "p1", recipient: "slack" },
    ] as never);
    const { done, report } = sweep(sources);

    await done;

    expect(pauses.setAsideStaleNoticesBefore).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
  });

  it("the project's own kinds of rows come after, each with its retention", async () => {
    const remove = vi.fn(() => Promise.resolve());
    const { sources } = sourcesOf({
      expiries: [{ what: "tasks", remove, retention: milliseconds(9000) }],
    });

    await sweep(sources).done;

    expect(remove).toHaveBeenCalledWith(cutoffOf(9000));
  });

  it("the kinds run in order, the ledger's after the outbound calls' and before the project's", async () => {
    const order: string[] = [];
    const log = (name: string) => () => {
      order.push(name);
      return Promise.resolve();
    };
    const { sources, pauses, stores, ledgerOwn } = sourcesOf({
      expiries: [{ what: "own", remove: log("own"), retention: milliseconds(1) }],
    });
    pauses.setAsideStaleNoticesBefore.mockImplementation(log("notices") as never);
    pauses.deleteByResolvedAtBefore.mockImplementation(log("pauses") as never);
    stores.meshRequests.deleteExpired.mockImplementation(log("mesh") as never);
    stores.executionHistory.deleteExpired.mockImplementation(log("history") as never);
    stores.fencedEffects.deleteExpired.mockImplementation(log("effects") as never);
    stores.auditLog.deleteExpired.mockImplementation(log("audit") as never);
    stores.outboundCalls.deleteExpired.mockImplementation(log("calls") as never);
    ledgerOwn.deleteByMadeAtBefore.mockImplementation(log("ledger") as never);

    await sweep(sources).done;

    expect(order).toEqual([
      "notices",
      "pauses",
      "mesh",
      "history",
      "effects",
      "audit",
      "calls",
      "ledger",
      "own",
    ]);
  });
});

describe("#1366: what the sweep leaves", () => {
  it("a kind with no store, or with no retention, is left alone — the ledger's too", async () => {
    const { sources, ledgerOwn, stores } = sourcesOf({
      ledgerEntryRetention: undefined,
      auditLogRetention: undefined,
      meshRequests: undefined,
    });

    const { done, report } = sweep(sources);
    await done;

    expect(ledgerOwn.deleteByMadeAtBefore).not.toHaveBeenCalled();
    expect(stores.auditLog.deleteExpired).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("an application with no ledger has none to prune", async () => {
    const { sources, report } = (() => {
      const made = sourcesOf({ ledger: undefined });
      return { sources: made.sources, report: sweep(made.sources) };
    })();

    await report.done;

    expect(report.report).not.toHaveBeenCalled();
    expect(sources).toBeDefined();
  });

  it("a retention of 0 removes everything older than now: it is a retention, not none", async () => {
    const { sources, ledgerOwn } = sourcesOf({ ledgerEntryRetention: milliseconds(0) });

    await sweep(sources).done;

    expect(ledgerOwn.deleteByMadeAtBefore).toHaveBeenCalledWith(NOW);
  });
});

describe("#1366: a store that fails is reported and asked again at the next look", () => {
  it.each([
    [
      "the resolved pause records",
      (s: ReturnType<typeof sourcesOf>) => s.pauses.deleteByResolvedAtBefore,
    ],
    [
      "the mesh requests' answers",
      (s: ReturnType<typeof sourcesOf>) => s.stores.meshRequests.deleteExpired,
    ],
    [
      "the kept execution records",
      (s: ReturnType<typeof sourcesOf>) => s.stores.executionHistory.deleteExpired,
    ],
    [
      "the idempotent effects' expired results",
      (s: ReturnType<typeof sourcesOf>) => s.stores.fencedEffects.deleteExpired,
    ],
    [
      "the audit log's old rows",
      (s: ReturnType<typeof sourcesOf>) => s.stores.auditLog.deleteExpired,
    ],
    [
      "the expired outbound calls",
      (s: ReturnType<typeof sourcesOf>) => s.stores.outboundCalls.deleteExpired,
    ],
    [
      "the ledger's old entries",
      (s: ReturnType<typeof sourcesOf>) => s.ledgerOwn.deleteByMadeAtBefore,
    ],
    [
      "the notices of a receiver no instance knows",
      (s: ReturnType<typeof sourcesOf>) => s.pauses.setAsideStaleNoticesBefore,
    ],
  ])("%s", async (what, method) => {
    const made = sourcesOf();
    method(made).mockRejectedValue(new Error("down"));
    const { done, report } = sweep(made.sources);

    await done;

    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(`${what} could not be removed: Error: down`);
    // the others were still asked
    expect(made.ledgerOwn.deleteByMadeAtBefore).toHaveBeenCalled();
    expect(made.stores.outboundCalls.deleteExpired).toHaveBeenCalled();
  });
});

describe("#1356: the idle memory threads", () => {
  const IDLE = "the idle memory threads";
  const treeOf = (id: string) => ({ tenantId: "t-1", rootExecutionId: id });
  type Tree = ReturnType<typeof treeOf>;

  /**
   * The idle-thread store: it asks of each tree whether it ended, as the real one does, then removes the records
   * of `removes` (the trees whose thread it removed) and counts them.
   */
  const threadsOf = (
    statuses: Record<string, string>,
    removes: readonly string[],
    told: number = removes.length,
  ) => {
    const records = new Map(Object.entries(statuses));
    const cuts: ReadonlyMap<string, Date>[] = [];
    const deleteIdleThreads = vi.fn(
      async (cutoffs: ReadonlyMap<string, Date>, isEnded: (tree: Tree) => Promise<boolean>) => {
        cuts.push(cutoffs);
        for (const id of Object.keys(statuses)) await isEnded(treeOf(id));
        for (const id of removes) records.delete(id);
        return told;
      },
    );
    const findByTenantIdAndRunId = vi.fn((_tenant: string, id: string) =>
      Promise.resolve(records.has(id) ? ({ status: records.get(id) } as never) : undefined),
    );
    return {
      threadRecords: { deleteIdleThreads, findByTenantIdAndRunId },
      deleteIdleThreads,
      findByTenantIdAndRunId,
      cuts,
    };
  };
  const ttls = new Map([
    ["wf-a", milliseconds(1000)],
    ["wf-b", milliseconds(60_000)],
  ]);
  const idleLooks = (made: ReturnType<typeof sourcesOf>) =>
    made.stores.auditLog.deleteExpired.mock.calls.filter(
      ([cut]) => cut.getTime() === NOW.getTime() + 1,
    );

  it("are removed per workflow at the cut its ttl gives from now, and the count removed is told", async () => {
    const threads = threadsOf({ r1: "answered", r2: "running" }, ["r1"]);
    const made = sourcesOf({ threadRecords: threads.threadRecords, threadTtls: ttls });

    const swept = await sweep(made.sources).done;

    expect(swept.find((one) => one.what === IDLE)).toEqual({ what: IDLE, removed: 1 });
    expect([...(threads.cuts[0] ?? [])]).toEqual([
      ["wf-a", new Date(NOW.getTime() - 1000)],
      ["wf-b", new Date(NOW.getTime() - 60_000)],
    ]);
  });

  it.each([
    ["no records of threads", { threadRecords: undefined }],
    ["no ttl of any workflow listed", { threadTtls: undefined }],
    ["an empty list of ttls", { threadTtls: new Map() }],
  ])("%s: none are looked for", async (_why, changes) => {
    const threads = threadsOf({ r1: "answered" }, ["r1"]);
    const made = sourcesOf({
      threadRecords: threads.threadRecords,
      threadTtls: ttls,
      ...changes,
    });

    const swept = await sweep(made.sources).done;

    expect(swept.map((one) => one.what)).not.toContain(IDLE);
    expect(threads.deleteIdleThreads).not.toHaveBeenCalled();
  });

  it("the audit rows of an ended tree whose record is gone go with it, whenever they were written, and no other tree's", async () => {
    // r1 ended and its thread went with its record; r2 ended and its record is still there; r3 is live
    const threads = threadsOf({ r1: "answered", r2: "answered", r3: "running" }, ["r1"]);
    const made = sourcesOf({ threadRecords: threads.threadRecords, threadTtls: ttls });

    await sweep(made.sources).done;

    const [look] = idleLooks(made);
    expect(idleLooks(made)).toHaveLength(1);
    expect(look?.[0]).toEqual(new Date(NOW.getTime() + 1));
    const goneOf = look?.[1] as (tree: Tree) => Promise<boolean>;
    expect(await goneOf(treeOf("r1"))).toBe(true);
    expect(await goneOf(treeOf("r2"))).toBe(false);
    expect(await goneOf(treeOf("r3"))).toBe(false);
    expect(await goneOf({ tenantId: "t-2", rootExecutionId: "r1" })).toBe(false);
  });

  it("a tree that did not end is not asked about again: a live tree whose record is missing keeps its rows", async () => {
    // r3 is live and its record is gone after the look (it was never removed by this sweep's own doing)
    const threads = threadsOf({ r1: "answered", r3: "running" }, ["r1", "r3"]);
    const made = sourcesOf({ threadRecords: threads.threadRecords, threadTtls: ttls });

    await sweep(made.sources).done;

    const goneOf = idleLooks(made)[0]?.[1] as (tree: Tree) => Promise<boolean>;
    expect(await goneOf(treeOf("r1"))).toBe(true);
    expect(await goneOf(treeOf("r3"))).toBe(false);
  });

  it("nothing is asked of the audit log when no thread was removed, when no tree lost its record, or when there is no audit log", async () => {
    const none = threadsOf({ r1: "running" }, []);
    const kept = threadsOf({ r1: "answered" }, ["r2"]);
    const noLog = threadsOf({ r1: "answered" }, ["r1"]);
    const silent = threadsOf({ r1: "answered" }, ["r1"], 0); // the store removed it and counted none
    const first = sourcesOf({ threadRecords: none.threadRecords, threadTtls: ttls });
    const second = sourcesOf({ threadRecords: kept.threadRecords, threadTtls: ttls });
    const third = sourcesOf({
      threadRecords: noLog.threadRecords,
      threadTtls: ttls,
      auditLog: undefined,
    });

    const fourth = sourcesOf({ threadRecords: silent.threadRecords, threadTtls: ttls });
    await sweep(first.sources).done;
    await sweep(second.sources).done;
    await sweep(fourth.sources).done;
    const swept = await sweep(third.sources).done;

    expect(idleLooks(fourth)).toHaveLength(0);
    expect(idleLooks(first)).toHaveLength(0);
    expect(idleLooks(second)).toHaveLength(0);
    expect(swept.find((one) => one.what === IDLE)).toEqual({ what: IDLE, removed: 1 });
    expect(noLog.findByTenantIdAndRunId).toHaveBeenCalledOnce();
  });
});

describe("#1356: what each look tells, exactly", () => {
  it("is one entry per kind that was asked, in order, a count only when the store gave one, a failure with its class and code", async () => {
    const { sources, ledgerOwn } = sourcesOf({
      meshRequests: undefined,
      executionHistory: undefined,
      fencedEffects: undefined,
      auditLog: undefined,
      outboundCalls: undefined,
    });
    ledgerOwn.deleteByMadeAtBefore.mockRejectedValue(
      Object.assign(new TypeError("no ledger"), { code: "x" }),
    );
    sources.pauses.deleteByResolvedAtBefore = vi.fn(() => Promise.resolve("not a count" as never));

    const swept = await sweep(sources).done;

    expect(swept).toStrictEqual([
      { what: "the notices of a receiver no instance knows", removed: undefined },
      { what: "the resolved pause records", removed: undefined },
      {
        what: "the ledger's old entries",
        removed: undefined,
        failure: { name: "TypeError", code: "x" },
      },
    ]);
  });
});
