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
  bundle,
  createdAt: "2026-01-05T09:00:00.000Z",
  task: "",
  replyWith: "",
  status,
  stopReason: "",
  route: [],
  steps: [],
  costUsd: 0,
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
