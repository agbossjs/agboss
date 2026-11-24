import { usd } from "../../src/units/index.js";
/**
 * #1187 — the orphan look's wake of a `paused` root beside an answer no pass took, on its own: a
 * root with a resolved pause is woken (a pending sibling after it on the page too), never closed;
 * one whose pause is still pending rests; a running one is recovery's, an ended one's end finished;
 * and a resting one whose cancel was requested is ended (#1152), never woken.
 */
import { describe, expect, it, vi } from "vitest";
import { OrphanLook, type OrphanSources } from "../../src/infrastructure/orphan-pauses.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import { NO_RECIPIENTS } from "../../src/infrastructure/pause-record.js";
import { APPROVED_BY_MANAGER, pauseOf } from "../../src/testing/contracts/paused-execution-data.js";
import type { Turn } from "../../src/turns/index.js";

const turnOf = (runId: string, status: Turn["status"], bundle = "orders-workflow"): Turn => ({
  id: `turn-${runId}`,
  runId,
  threadId: `thread-${runId}`,
  tenantId: "default",
  workflow: bundle,
  createdAt: "2026-01-05T09:00:00.000Z",
  task: "",
  replyWith: "",
  status,
  stopReason: "",
  route: [],
  steps: [],
  costUsd: usd(0),
  promptVersion: "",
  modelVersion: "",
  replayOf: null,
  configVersion: null,
  configHash: null,
});

describe("#1187: the look wakes a paused root beside an answer no pass took", () => {
  /** One root's pause, resolved (an answer recorded, not taken) or left pending. */
  async function onePause(isResolved: boolean): Promise<InMemoryPausedExecutionRepository> {
    const pauses = new InMemoryPausedExecutionRepository();
    await pauses.findOrCreateByStepKey({
      ...pauseOf("p-1", "run-1:clerk-agent:1:call-1"),
      rootExecutionId: "run-1",
    });
    if (isResolved)
      await pauses.resolveByTenantIdAndPauseId(
        "default",
        "p-1",
        APPROVED_BY_MANAGER,
        new Date("2026-01-05T09:00:00.000Z"),
        NO_RECIPIENTS,
      );
    return pauses;
  }

  /** `isCancelled`: the resting tree's cancel was requested — the close ends it (#1152). */
  function wakingLookOf(
    pauses: InMemoryPausedExecutionRepository,
    status: Turn["status"],
    isCancelled = false,
  ) {
    const woken: string[] = [];
    const closed: string[] = [];
    const sources: OrphanSources = {
      pauses,
      records: {
        findByTenantIdAndRunId: (_tenant, runId) => Promise.resolve(turnOf(runId, status)),
      },
      orphans: new Map([
        [
          "orders-workflow",
          (record) => {
            // the real close ends a resting tree only when its cancel was requested
            const isClosed = record.status !== "paused" || isCancelled;
            if (isClosed) closed.push(record.runId ?? "");
            return Promise.resolve(isClosed);
          },
        ],
      ]),
      wakes: new Map([
        [
          "orders-workflow",
          (record) => {
            woken.push(record.runId ?? "");
            return Promise.resolve(true);
          },
        ],
      ]),
      report: vi.fn(),
    };
    return { look: new OrphanLook(sources), woken, closed };
  }

  it("a paused root with a resolved pause is woken, never closed", async () => {
    const { look, woken, closed } = wakingLookOf(await onePause(true), "paused");

    await look.look(() => false);

    expect(woken).toEqual(["run-1"]);
    expect(closed).toEqual([]);
  });

  it("trap 3: a root's resolved pause followed on the page by a pending sibling is still woken", async () => {
    const pauses = await onePause(true);
    await pauses.findOrCreateByStepKey({
      ...pauseOf("p-2", "run-1:clerk-agent:2:call-2"),
      rootExecutionId: "run-1",
    });
    const { look, woken } = wakingLookOf(pauses, "paused");

    await look.look(() => false);

    expect(woken).toEqual(["run-1"]);
  });

  it("#1152 first: a resting root whose cancel was requested is ended, never woken, its answer untaken", async () => {
    const { look, woken, closed } = wakingLookOf(await onePause(true), "paused", true);

    await look.look(() => false);

    expect({ woken, closed }).toEqual({ woken: [], closed: ["run-1"] });
  });

  it("a paused root whose pause is still pending rests: nothing woken", async () => {
    const { look, woken, closed } = wakingLookOf(await onePause(false), "paused");

    await look.look(() => false);

    expect({ woken, closed }).toEqual({ woken: [], closed: [] });
  });

  it("a running root with a resolved pause is recovery's, an ended one's end is finished", async () => {
    const running = wakingLookOf(await onePause(true), "running");
    const ended = wakingLookOf(await onePause(true), "answered");

    await running.look.look(() => false);
    await ended.look.look(() => false);

    expect({ woken: running.woken, closed: running.closed }).toEqual({ woken: [], closed: [] });
    expect({ woken: ended.woken, closed: ended.closed }).toEqual({ woken: [], closed: ["run-1"] });
  });
});

describe("#1341c: the look wakes a parked root an unpause died on — found by the `paused` status, not by a pause", () => {
  /** A store of records by status: `paused` roots, two pages of them (the first of `ORPHAN_PAGE`). */
  function parkedLookOf(
    roots: readonly string[],
    known: readonly string[] = ["orders-workflow"],
    fails: readonly string[] = [],
  ) {
    const woken: string[] = [];
    const asked: { status: string; cursor?: string | undefined }[] = [];
    const items = roots.map((runId) => turnOf(runId, "paused"));
    const sources: OrphanSources = {
      pauses: new InMemoryPausedExecutionRepository(),
      records: { findByTenantIdAndRunId: () => Promise.resolve(undefined) },
      orphans: new Map(),
      parked: {
        wakes: new Map(
          known.map((bundle) => [
            bundle,
            (record: Turn) => {
              if (fails.includes(record.runId ?? ""))
                return Promise.reject(new Error("store down"));
              woken.push(record.runId ?? "");
              return Promise.resolve(true);
            },
          ]),
        ),
        list: {
          findByStatus: (query) => {
            asked.push({ status: query.status, cursor: query.cursor });
            const from = query.cursor === undefined ? 0 : roots.indexOf(query.cursor.slice(5)) + 1;
            const page = items.slice(from, from + (query.limit ?? 100));
            const last = page.at(-1);
            return Promise.resolve(
              from + page.length < items.length && last !== undefined
                ? { items: page, nextCursor: last.id }
                : { items: page },
            );
          },
        },
      },
      report: vi.fn(),
    };
    return { look: new OrphanLook(sources), woken, asked, report: sources.report };
  }

  it("every `paused` record of a known workflow is offered to its wake, whatever its pauses", async () => {
    const { look, woken, asked } = parkedLookOf(["run-1", "run-2"]);

    await look.lookParked(() => false);

    expect(woken).toEqual(["run-1", "run-2"]);
    expect(asked).toEqual([{ status: "paused", cursor: undefined }]);
  });

  it("a record of a workflow with no wake here is skipped; the look is off without wakes", async () => {
    const other = parkedLookOf(["run-1"], ["another-workflow"]);
    const none = parkedLookOf(["run-1"], []);

    await other.look.lookParked(() => false);
    await none.look.lookParked(() => false);

    expect(other.woken).toEqual([]);
    expect(none.asked).toEqual([]);
  });

  it("a wake that fails is reported and the page goes on", async () => {
    const { look, woken, report } = parkedLookOf(["run-1", "run-2", "run-3"], undefined, ["run-2"]);

    await look.lookParked(() => false);

    expect(woken).toEqual(["run-1", "run-3"]);
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(expect.stringContaining("run-2"));
    expect(report).toHaveBeenCalledWith(expect.not.stringContaining("thread-run-2"));
  });

  it("a look told to stop wakes no more of the page", async () => {
    const { look, woken } = parkedLookOf(["run-1", "run-2", "run-3"]);
    let calls = 0;

    await look.lookParked(() => {
      calls += 1;
      return calls > 1;
    });

    expect(woken).toEqual(["run-1"]);
  });
});
