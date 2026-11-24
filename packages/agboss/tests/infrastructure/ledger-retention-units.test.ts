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
    meshRequests: store("deleteByCreatedAtBefore"),
    executionHistory: store("deleteByEndedAtBefore"),
    fencedEffects: store("deleteByStoredAtBefore"),
    auditLog: store("deleteByOccurredAtBefore"),
    outboundCalls: store("deleteByEndedAtBefore"),
  };
  const sources = {
    clock: { now: () => NOW },
    pauses,
    pauseRecordRetention: milliseconds(1000),
    ...stores,
    idempotencyRetention: 2000,
    executionRecordRetention: milliseconds(3000),
    fencedEffectRetention: milliseconds(4000),
    auditLogRetention: milliseconds(5000),
    outboundCallRetention: milliseconds(6000),
    ledger: ledgerOwn,
    ledgerEntryRetention: milliseconds(7000),
    ...changes,
  };
  return { sources: sources as RetentionSources, pauses, ledgerOwn, stores };
};

const sweep = (sources: RetentionSources) => {
  const report = vi.fn();
  return { report, done: removeExpired(sources, report) };
};

describe("#1366: the sweep removes each kind of rows past its retention", () => {
  it("the ledger's entries made before the cut, through the ledger itself", async () => {
    const { sources, ledgerOwn } = sourcesOf();
    const { done, report } = sweep(sources);

    await done;

    expect(ledgerOwn.deleteByMadeAtBefore).toHaveBeenCalledOnce();
    expect(ledgerOwn.deleteByMadeAtBefore).toHaveBeenCalledWith(cutoffOf(7000));
    expect(report).not.toHaveBeenCalled();
  });

  it("every other kind, each at its own cut", async () => {
    const { sources, pauses, stores } = sourcesOf();

    await sweep(sources).done;

    expect(pauses.deleteByResolvedAtBefore).toHaveBeenCalledWith(cutoffOf(1000));
    expect(stores.meshRequests.deleteByCreatedAtBefore).toHaveBeenCalledWith(cutoffOf(2000));
    expect(stores.executionHistory.deleteByEndedAtBefore).toHaveBeenCalledWith(cutoffOf(3000));
    expect(stores.fencedEffects.deleteByStoredAtBefore).toHaveBeenCalledWith(cutoffOf(4000));
    expect(stores.auditLog.deleteByOccurredAtBefore).toHaveBeenCalledWith(cutoffOf(5000));
    expect(stores.outboundCalls.deleteByEndedAtBefore).toHaveBeenCalledWith(cutoffOf(6000));
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

    await expect(done).resolves.toBeUndefined();

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
    stores.meshRequests.deleteByCreatedAtBefore.mockImplementation(log("mesh") as never);
    stores.executionHistory.deleteByEndedAtBefore.mockImplementation(log("history") as never);
    stores.fencedEffects.deleteByStoredAtBefore.mockImplementation(log("effects") as never);
    stores.auditLog.deleteByOccurredAtBefore.mockImplementation(log("audit") as never);
    stores.outboundCalls.deleteByEndedAtBefore.mockImplementation(log("calls") as never);
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
    expect(stores.auditLog.deleteByOccurredAtBefore).not.toHaveBeenCalled();
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
      (s: ReturnType<typeof sourcesOf>) => s.stores.meshRequests.deleteByCreatedAtBefore,
    ],
    [
      "the kept execution records",
      (s: ReturnType<typeof sourcesOf>) => s.stores.executionHistory.deleteByEndedAtBefore,
    ],
    [
      "the fenced effects' results",
      (s: ReturnType<typeof sourcesOf>) => s.stores.fencedEffects.deleteByStoredAtBefore,
    ],
    [
      "the audit log's old rows",
      (s: ReturnType<typeof sourcesOf>) => s.stores.auditLog.deleteByOccurredAtBefore,
    ],
    [
      "the ended outbound calls",
      (s: ReturnType<typeof sourcesOf>) => s.stores.outboundCalls.deleteByEndedAtBefore,
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
    expect(made.stores.outboundCalls.deleteByEndedAtBefore).toHaveBeenCalled();
  });
});
