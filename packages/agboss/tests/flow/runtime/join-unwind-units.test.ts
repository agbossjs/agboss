/**
 * #633 (unwind shard) — a failed join's undo (`unwoundJoin`, #340 Q3, #607) on its own, its unwind
 * scripted: the launching node named or a TypeError, its launch's entries of its execution only,
 * the branches it waits for, never a seal, the undo's spend written before the error, each undo
 * marked in the tree's store, and the entries an earlier pass undid closed by the join's update.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPENSATION_TIMEOUT,
  CompensationEntryStatus,
  CompensationFailedError,
  CompensationReason,
  CompensationStatus,
  type CompensationEntry,
} from "../../../src/flow/compensation.js";
import {
  unwoundJoin,
  type JoinUnwindSite,
} from "../../../src/flow/runtime/compensation/join-unwind.js";
import type { UnwindSite } from "../../../src/flow/runtime/compensation/unwind.js";
import {
  compensatedKeyOf,
  markUndone,
} from "../../../src/flow/runtime/compensation/unwinding-marks.js";
import { recordToolCost } from "../../../src/finops/usage.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { InMemoryExecutionTreeRepository } from "../../../src/infrastructure/execution-tree.repository.js";
import { VirtualClock } from "../../../src/testing/index.js";
import { seconds } from "../../../src/units/index.js";
import { closedOf, entryOf, TREE } from "./fixtures/compensation-entries.js";

const mocks = vi.hoisted(() => ({ unwound: vi.fn() }));
const CLOCK = new VirtualClock();

vi.mock("../../../src/flow/runtime/compensation/unwind.js", () => ({ unwound: mocks.unwound }));
vi.mock("../../../src/flow/runtime/step-frame.js", () => ({
  stepFrameAt: () => ({
    execution: { executionId: "root-1", tenant: { tenantId: "acme" } },
  }),
}));
vi.mock("../../../src/core/run-context.js", () => ({
  extractRunContext: () => ({ clock: CLOCK }),
}));

const USAGE = recordToolCost("release-room-action", 0.25);
const LAUNCH = "root-1:book-launch:1";

const inLaunch = (key: string, overrides: Partial<CompensationEntry> = {}) =>
  entryOf(key, { launchId: LAUNCH, ...overrides });

function siteOf(compensations: readonly CompensationEntry[], withParts = true) {
  const trees = new InMemoryExecutionTreeRepository(new InMemoryDatabase());
  const record = vi.fn((_usage: readonly unknown[]) => Promise.resolve());
  const site = {
    state: { runId: "root-1", compensations },
    config: undefined,
    ticket: {
      launchId: LAUNCH,
      launcher: "book-launch",
      visitNumber: 1,
      branches: [{ nodeId: "reserve-room-action" }],
    },
    deps: {
      graph: { nodes: new Map([["book-launch", {}]]) },
      container: {},
      components: new Map(),
      observer: undefined,
      stepEntries: undefined,
      compensation: withParts ? { timeout: seconds(6), registry: {}, trees } : undefined,
      limits: { budgets: { record } },
    },
    cause: new Error("branch failed"),
  } as never as JoinUnwindSite;
  return { site, trees, record };
}

const unwindAsked = (): UnwindSite => mocks.unwound.mock.calls[0]?.[0] as UnwindSite;

beforeEach(() => {
  mocks.unwound.mockReset();
  mocks.unwound.mockImplementation((site: UnwindSite) =>
    Promise.resolve({
      closed: site.known
        .filter((e) => e.status === CompensationEntryStatus.Open)
        .map((e) => closedOf(e)),
      usage: [USAGE],
      failures: [],
    }),
  );
});

describe("#633: the join's unwind", () => {
  it("a launcher that is no node: a TypeError naming it", async () => {
    const { site } = siteOf([]);

    await expect(
      unwoundJoin({ ...site, ticket: { ...site.ticket, launcher: "gone-launch" } }),
    ).rejects.toThrow(new TypeError("gone-launch is not a node of the graph"));
  });

  it("its launch's entries of its own execution, the branches it waits for, no seal, its bound", async () => {
    const entries = [
      inLaunch("mine"),
      inLaunch("other execution's", { executionId: "child-1" }),
      entryOf("other launch's", { launchId: "root-1:other:1" }),
    ];
    const { site } = siteOf(entries);

    await unwoundJoin(site);
    const unwind = unwindAsked();

    expect(unwind.known.map((entry) => entry.key)).toEqual(["mine"]);
    expect(unwind.tree).toEqual(TREE);
    expect(entries.map((entry) => unwind.covers(entry))).toEqual([true, false, false]);
    const body = (executionId: string, nodeId: string) => ({ executionId, nodeId }) as never;
    expect([
      unwind.runs(body("root-1", "reserve-room-action")),
      unwind.runs(body("child-1", "reserve-room-action")),
      unwind.runs(body("root-1", "other-action")),
    ]).toEqual([true, false, false]);
    expect({ isSealing: unwind.isSealing, timeout: unwind.timeout }).toEqual({
      isSealing: false,
      timeout: seconds(6),
    });
    expect(unwind.undoSiteOf(entryOf("x")).reason).toBe(CompensationReason.JoinFailed);
    expect(unwind.clock).toBe(CLOCK);
  });

  it("no compensation parts: the default bound, no marks", async () => {
    const { site } = siteOf([inLaunch("mine")], false);

    await unwoundJoin(site);

    expect(unwindAsked().timeout).toBe(COMPENSATION_TIMEOUT);
  });

  it("each undo marked done in the tree's store; its spend for the join's update", async () => {
    const { site, trees, record } = siteOf([inLaunch("mine")]);

    const undo = await unwoundJoin(site);
    await unwindAsked().onUndone?.(closedOf(inLaunch("mine")));
    await unwindAsked().record([USAGE]);

    expect(await trees.findByIdInTree(TREE, compensatedKeyOf("mine"))).toBeDefined();
    expect(record).toHaveBeenCalledWith([USAGE]);
    expect(undo.usage).toEqual([USAGE]);
    expect((undo.compensations ?? []).map((entry) => entry.key)).toEqual(["mine"]);
  });

  it("an undo that failed: its spend written first, then CompensationFailedError caused by the branch's", async () => {
    const { site, record } = siteOf([inLaunch("mine")]);
    const failure = closedOf(inLaunch("mine"), CompensationStatus.Failed).undo;
    mocks.unwound.mockResolvedValue({ closed: [], usage: [USAGE], failures: [failure] });

    const failing = unwoundJoin(site);

    await expect(failing).rejects.toBeInstanceOf(CompensationFailedError);
    await expect(failing).rejects.toMatchObject({ cause: site.cause });
    expect(record).toHaveBeenCalledWith([USAGE]);
  });

  it("what an earlier pass undid: closed by its mark in the join's update — only entries the state holds open", async () => {
    const { site, trees } = siteOf([inLaunch("undone"), closedOf(inLaunch("closed"))]);
    await markUndone({ trees, tree: TREE }, closedOf(inLaunch("undone")));
    await markUndone({ trees, tree: TREE }, closedOf(inLaunch("closed")));

    const undo = await unwoundJoin(site);

    expect((undo.compensations ?? []).map((entry) => [entry.key, entry.status])).toEqual([
      ["undone", CompensationEntryStatus.Closed],
    ]);
  });
});
