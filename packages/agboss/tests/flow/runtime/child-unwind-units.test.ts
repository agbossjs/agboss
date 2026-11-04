/**
 * #633 (unwind shard) — a child's own undo before its error reaches its parent (`unwoundChild`,
 * #340 Q2) on its own, its unwind scripted: its own entries of its checkpoint and its last state
 * through the marks, marked under its own key, its undo actions' frame its own — its place in the
 * tree and its parent's lease when it has them —, sealed, its spend to the budgets at once, and its
 * error wrapped in `CompensationFailedError` only when an undo failed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPENSATION_TIMEOUT,
  CompensationFailedError,
  CompensationReason,
  CompensationStatus,
  type CompensationEntry,
} from "../../../src/flow/compensation.js";
import { ExecutionCancelledError } from "../../../src/core/errors.js";
import {
  unwoundChild,
  type ChildUnwindSite,
} from "../../../src/flow/runtime/compensation/child-unwind.js";
import type { UnwindSite } from "../../../src/flow/runtime/compensation/unwind.js";
import {
  childUnwindingKeyOf,
  markUndone,
  unwindingOf,
} from "../../../src/flow/runtime/compensation/unwinding-marks.js";
import { recordToolCost } from "../../../src/finops/usage.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { InMemoryExecutionTreeRepository } from "../../../src/infrastructure/execution-tree.repository.js";
import { VirtualClock } from "../../../src/testing/index.js";
import { seconds } from "../../../src/units/index.js";
import { closedOf, entryOf, TREE } from "./fixtures/compensation-entries.js";

const mocks = vi.hoisted(() => ({ unwound: vi.fn(), entriesInCheckpoint: vi.fn() }));
const CLOCK = new VirtualClock();

vi.mock("../../../src/flow/runtime/compensation/unwind.js", () => ({ unwound: mocks.unwound }));
vi.mock("../../../src/flow/runtime/compensation/checkpoint-entries.js", () => ({
  entriesInCheckpoint: mocks.entriesInCheckpoint,
}));
vi.mock("../../../src/core/run-context.js", () => ({
  extractRunContext: () => ({ clock: CLOCK }),
}));
vi.mock("../../../src/flow/runtime/workflow-keys.js", () => ({
  joinKeysOf: () => ({ components: new Map() }),
}));

const USAGE = recordToolCost("release-room-action", 0.25);
const CHILD = "child-1";
const ofChild = (key: string, overrides: Partial<CompensationEntry> = {}) =>
  entryOf(key, { executionId: CHILD, ...overrides });

interface SiteOptions {
  readonly withParts?: boolean;
  readonly checkpointer?: boolean;
  readonly budgets?: boolean;
  readonly tree?: { parent: unknown; itemIndex: number };
  readonly lease?: unknown;
  readonly last?: readonly CompensationEntry[];
}

function siteOf(options: SiteOptions = {}) {
  const trees = new InMemoryExecutionTreeRepository(new InMemoryDatabase());
  const record = vi.fn((_usage: readonly unknown[]) => Promise.resolve());
  const signal = new AbortController().signal;
  const site = {
    deps: {
      graph: {},
      container: {},
      observer: undefined,
      stepEntries: undefined,
      compensation:
        options.withParts === false ? undefined : { timeout: seconds(7), registry: {}, trees },
    },
    workflow: { name: "child-workflow", version: "2.0.0" },
    executionId: CHILD,
    run: {
      threadId: "thread-1",
      ownerId: "alice",
      signal,
      ...(options.tree === undefined ? {} : { tree: options.tree }),
      ...(options.lease === undefined ? {} : { lease: options.lease }),
    },
    parent: {
      execution: { executionId: "root-1", tenant: { tenantId: "acme" }, values: { v: 1 } },
    },
    config: {},
    checkpointer: options.checkpointer === false ? undefined : {},
    budgets: options.budgets === false ? undefined : { record },
    last: options.last ?? [],
    error: new Error("child's own"),
  } as never as ChildUnwindSite;
  return { site, trees, record, signal };
}

const unwindAsked = (): UnwindSite => mocks.unwound.mock.calls[0]?.[0] as UnwindSite;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.entriesInCheckpoint.mockResolvedValue([]);
  mocks.unwound.mockImplementation((site: UnwindSite) =>
    Promise.resolve({
      closed: site.known.map((entry) => closedOf(entry)),
      usage: [USAGE],
      failures: [],
    }),
  );
});

describe("#633: the child's entries and its mark", () => {
  it("its own of its checkpoint and its last state, through the marks; marked under its own key", async () => {
    const { site, trees } = siteOf({ last: [ofChild("last"), entryOf("parent's")] });
    await markUndone({ trees, tree: TREE }, closedOf(ofChild("done")));
    mocks.entriesInCheckpoint.mockResolvedValue([
      { namespace: "book:1", executionId: CHILD, entries: [ofChild("done"), entryOf("root's")] },
    ]);

    await unwoundChild(site, site.error);
    const unwind = unwindAsked();

    expect(unwind.known.map((entry) => [entry.key, entry.status])).toEqual([
      ["done", "closed"],
      ["last", "open"],
    ]);
    expect([unwind.covers(ofChild("x")), unwind.covers(entryOf("x"))]).toEqual([true, false]);
    expect([unwind.runs(ofChild("x") as never), unwind.runs(entryOf("x") as never)]).toEqual([
      true,
      false,
    ]);
    expect(await unwindingOf(trees, TREE, childUnwindingKeyOf(CHILD))).toMatchObject({
      cause: { message: "child's own" },
    });
  });

  it("no checkpointer and no compensation parts: its last state only, the default bound", async () => {
    const { site } = siteOf({ checkpointer: false, withParts: false, last: [ofChild("last")] });

    await unwoundChild(site, site.error);

    expect(mocks.entriesInCheckpoint).not.toHaveBeenCalled();
    expect(unwindAsked().known.map((entry) => entry.key)).toEqual(["last"]);
    expect(unwindAsked().timeout).toBe(COMPENSATION_TIMEOUT);
  });
});

describe("#633: where the child's undo runs", () => {
  it("its own facts — and its place in the tree and its parent's lease when it has them", async () => {
    const lease = { scopeKey: "acme:root-1" };
    const parent = { execution: {} };
    const { site, signal } = siteOf({ tree: { parent, itemIndex: 2 }, lease });

    await unwoundChild(site, new ExecutionCancelledError("fail-fast"));
    const undo = unwindAsked().undoSiteOf(ofChild("x"));

    expect(undo.execution).toStrictEqual({
      executionId: CHILD,
      threadId: "thread-1",
      ownerId: "alice",
      signal,
      workflow: { name: "child-workflow", version: "2.0.0", startedVersion: "2.0.0" },
      tenant: { tenantId: "acme" },
      values: { v: 1 },
      parent,
      itemIndex: 2,
      lease,
    });
    expect(undo.reason).toBe(CompensationReason.ExecutionCancelled);
    expect([undo.timeout, undo.clock]).toEqual([seconds(7), CLOCK]);
    expect(unwindAsked().isSealing).toBe(true);
  });

  it("neither: none of them on its facts", async () => {
    const { site } = siteOf();

    await unwoundChild(site, site.error);
    const facts = unwindAsked().undoSiteOf(ofChild("x")).execution;

    expect(Object.keys(facts).sort()).toEqual(
      ["executionId", "ownerId", "signal", "tenant", "threadId", "values", "workflow"].sort(),
    );
  });
});

describe("#633: the child's undo's end", () => {
  it("its spend to the budgets at once; its error as it was", async () => {
    const { site, record } = siteOf();

    const ended = await unwoundChild(site, site.error);
    await unwindAsked().record([USAGE]);

    expect(record.mock.calls).toEqual([[[USAGE]], [[USAGE]]]);
    expect(ended.thrown).toBe(site.error);
  });

  it("no budgets: the spend goes nowhere, no error", async () => {
    const { site } = siteOf({ budgets: false });

    await expect(unwoundChild(site, site.error)).resolves.toMatchObject({ thrown: site.error });
  });

  it("an undo that failed: CompensationFailedError caused by the child's error", async () => {
    const { site } = siteOf();
    const failure = closedOf(ofChild("x"), CompensationStatus.Failed).undo;
    mocks.unwound.mockResolvedValue({ closed: [], usage: [], failures: [failure] });

    const ended = await unwoundChild(site, site.error);

    expect(ended.thrown).toBeInstanceOf(CompensationFailedError);
    expect((ended.thrown as CompensationFailedError).cause).toBe(site.error);
  });
});
