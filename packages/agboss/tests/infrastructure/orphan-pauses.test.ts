/**
 * #939 (#910 I13): the orphan look on its own — one page of open pauses per look, every open pause
 * visited within `ceil(open / 50)` looks, the cursor wrapping after the last page; a root that has
 * not ended, has no record here, or whose workflow is unknown is left alone; a failing end is
 * reported and the look goes on.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ORPHAN_PAGE,
  OrphanLook,
  type OrphanSources,
} from "../../src/infrastructure/orphan-pauses.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import { pauseOf } from "../../src/testing/contracts/paused-execution-data.js";
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

/** `count` open pauses, each of a root of its own (`run-0` …). */
async function openPauses(count: number): Promise<InMemoryPausedExecutionRepository> {
  const pauses = new InMemoryPausedExecutionRepository();
  for (let index = 0; index < count; index += 1)
    await pauses.findOrCreateByStepKey({
      ...pauseOf(`p-${String(index)}`, `run-${String(index)}:clerk-agent:1:call-1`),
      rootExecutionId: `run-${String(index)}`,
    });
  return pauses;
}

function lookOf(
  pauses: InMemoryPausedExecutionRepository,
  status: Turn["status"],
  isClosed = true,
) {
  const visited: string[] = [];
  const report = vi.fn();
  const sources: OrphanSources = {
    pauses,
    records: {
      findByTenantIdAndRunId: (_tenant, runId) => Promise.resolve(turnOf(runId, status)),
    },
    orphans: new Map([
      [
        "orders-workflow",
        (record) => {
          visited.push(record.runId ?? "");
          return Promise.resolve(isClosed);
        },
      ],
    ]),
    report,
  };
  return { look: new OrphanLook(sources), visited, report };
}

describe("#939: the orphan look", () => {
  it("120 open pauses are all visited within 3 looks (50 per page), and the 4th wraps to the first", async () => {
    const { look, visited } = lookOf(await openPauses(120), "failed", false);

    await look.look(() => false);
    expect(visited).toHaveLength(ORPHAN_PAGE);
    await look.look(() => false);
    await look.look(() => false);
    expect(new Set(visited).size).toBe(120);

    const before = visited.length;
    await look.look(() => false);
    expect(visited.slice(before)).toHaveLength(ORPHAN_PAGE);
    expect(visited.slice(before)[0]).toBe(visited[0]);
  });

  it("one root with many open pauses is ended once per look", async () => {
    const pauses = new InMemoryPausedExecutionRepository();
    for (let index = 0; index < 30; index += 1)
      await pauses.findOrCreateByStepKey(
        pauseOf(`p-${String(index)}`, `run-1:clerk-agent:1:call-${String(index)}`),
      );
    const { look, visited } = lookOf(pauses, "answered");

    await look.look(() => false);

    expect(visited).toEqual(["run-1"]);
  });

  it.each<Turn["status"]>(["running", "paused", "queued"])(
    "a root whose record is %s is skipped",
    async (status) => {
      const { look, visited, report } = lookOf(await openPauses(3), status);

      await look.look(() => false);

      expect(visited).toEqual([]);
      expect(report).not.toHaveBeenCalled();
    },
  );

  it("a root with no record, or of a workflow this instance does not build, is skipped", async () => {
    const pauses = await openPauses(2);
    const visited: string[] = [];
    const look = new OrphanLook({
      pauses,
      records: {
        findByTenantIdAndRunId: (_tenant, runId) =>
          Promise.resolve(runId === "run-0" ? undefined : turnOf(runId, "failed", "other")),
      },
      orphans: new Map([
        [
          "orders-workflow",
          (record) => {
            visited.push(record.id);
            return Promise.resolve(true);
          },
        ],
      ]),
      report: vi.fn(),
    });

    await look.look(() => false);

    expect(visited).toEqual([]);
  });

  it("a tree whose end fails is reported by its id and the others still end", async () => {
    const pauses = await openPauses(2);
    const ended: string[] = [];
    const report = vi.fn();
    const look = new OrphanLook({
      pauses,
      records: {
        findByTenantIdAndRunId: (_tenant, runId) => Promise.resolve(turnOf(runId, "failed")),
      },
      orphans: new Map([
        [
          "orders-workflow",
          (record) => {
            if (record.runId === "run-0") return Promise.reject(new Error("store down"));
            ended.push(record.runId ?? "");
            return Promise.resolve(true);
          },
        ],
      ]),
      report,
    });

    await look.look(() => false);

    expect(ended).toEqual(["run-1"]);
    expect(report).toHaveBeenCalledWith(expect.stringContaining("run-0"));
  });

  it("a stopped instance ends no more trees", async () => {
    const { look, visited } = lookOf(await openPauses(3), "failed");

    await look.look(() => true);

    expect(visited).toEqual([]);
  });
});
