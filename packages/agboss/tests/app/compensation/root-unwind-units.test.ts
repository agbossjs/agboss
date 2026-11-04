/**
 * #633 (unwind shard) — a root's automatic undo (`root-unwind.ts`) on its own, its unwind scripted:
 * a tree with nothing undoable (its children's workflows looked at too, each once) undoes nothing
 * and marks nothing; one with an undo reads its checkpoint's entries through the marks, undoes them
 * all under the call's lease, writes the undo's spend at once to the budgets its checkpoint keeps,
 * and ends with the cause — or `CompensationFailedError` when an undo failed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDeps } from "../../../src/app/app-deps.js";
import { markTreeUnwinding, unwoundTree } from "../../../src/app/compensation/root-unwind.js";
import { NodeKind } from "../../../src/flow/ast.js";
import {
  COMPENSATION_TIMEOUT,
  CompensationFailedError,
  CompensationReason,
  CompensationStatus,
} from "../../../src/flow/compensation.js";
import type { UnwindSite } from "../../../src/flow/runtime/compensation/unwind.js";
import {
  markUndone,
  unwindingOf,
  UNWINDING_KEY,
} from "../../../src/flow/runtime/compensation/unwinding-marks.js";
import { recordToolCost } from "../../../src/finops/usage.js";
import { InMemoryCostLedgerRepository } from "../../../src/infrastructure/cost-ledger.repository.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { InMemoryExecutionTreeRepository } from "../../../src/infrastructure/execution-tree.repository.js";
import { BudgetScope } from "../../../src/budgets/budget.js";
import { VirtualClock } from "../../../src/testing/index.js";
import { seconds } from "../../../src/units/index.js";
import { closedOf, entryOf, TREE } from "../../flow/runtime/fixtures/compensation-entries.js";

const mocks = vi.hoisted(() => ({
  unwound: vi.fn(),
  entriesInCheckpoint: vi.fn(),
  treeStateOf: vi.fn(),
}));

vi.mock("../../../src/flow/runtime/compensation/unwind.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/flow/runtime/compensation/unwind.js")>()),
  unwound: mocks.unwound,
}));
vi.mock("../../../src/flow/runtime/compensation/checkpoint-entries.js", () => ({
  entriesInCheckpoint: mocks.entriesInCheckpoint,
}));
vi.mock("../../../src/flow/runtime/workflow-keys.js", () => ({
  joinKeysOf: () => ({ components: new Map(), configHash: "hash" }),
  workflowIdentityOf: (deps: { config: { name: string; version?: string } }) => ({
    type: Object,
    name: deps.config.name,
    version: deps.config.version ?? "1.0.0",
    configHash: "hash",
  }),
}));
vi.mock("../../../src/app/pause-frame.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/app/pause-frame.js")>()),
  treeStateOf: mocks.treeStateOf,
}));

const STATE = { runId: "root-1", threadId: "thread-1", tenantId: "acme", startedVersion: "1" };
const USAGE = recordToolCost("release-room-action", 0.25);

const undoable = {
  kind: NodeKind.Action,
  declaration: { kind: NodeKind.Action, options: { compensateWith: Object } },
};
const plain = { kind: NodeKind.Action, declaration: { kind: NodeKind.Action, options: {} } };
const childNode = {
  kind: NodeKind.Workflow,
  component: "child",
  declaration: { kind: NodeKind.Workflow, options: {} },
};

interface DepsOptions {
  readonly nodes: readonly object[];
  readonly child?: readonly object[];
  readonly pause?: boolean;
  readonly budgets?: boolean;
  readonly compensation?: boolean;
  readonly owner?: string;
}

function depsOf(options: DepsOptions) {
  const trees = new InMemoryExecutionTreeRepository(new InMemoryDatabase());
  const ledger = new InMemoryCostLedgerRepository();
  const childDeps =
    options.child === undefined
      ? undefined
      : {
          config: { name: "child-workflow" },
          graph: { nodes: new Map(options.child.map((node, i) => [`c${String(i)}`, node])) },
        };
  const deps = {
    config: { name: "desk-workflow" },
    graph: { nodes: new Map(options.nodes.map((node, i) => [`n${String(i)}`, node])) },
    childDepsOf: (component: unknown) => (component === "child" ? childDeps : undefined),
    pause: options.pause === false ? undefined : { checkpointer: {} },
    budgets: options.budgets === true ? { ledger, clock: new VirtualClock() } : undefined,
    compensation:
      options.compensation === false
        ? undefined
        : { timeout: seconds(4), registry: { entriesOf: () => [] }, trees },
    terns: {
      threadOwner: () =>
        Promise.resolve(options.owner === undefined ? undefined : { owner: options.owner }),
    },
    observer: {},
    stepEntries: undefined,
    clock: new VirtualClock(),
  } as never as AppDeps;
  return { deps, trees, ledger };
}

const call = (cause: Error = new Error("declined")) => ({
  cause,
  signal: new AbortController().signal,
  lease: { scopeKey: "acme:root-1" } as never,
});

const unwindAsked = (): UnwindSite => mocks.unwound.mock.calls[0]?.[0] as UnwindSite;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.entriesInCheckpoint.mockResolvedValue([]);
  mocks.treeStateOf.mockResolvedValue({ budgets: [] });
  mocks.unwound.mockImplementation((site: UnwindSite) =>
    Promise.resolve({
      closed: site.known.map((entry) => closedOf(entry)),
      usage: [USAGE],
      failures: [],
    }),
  );
});

describe("#633: a tree with nothing to undo", () => {
  it.each([
    ["no undoable action anywhere", { nodes: [plain, childNode], child: [plain] }],
    ["a child node whose workflow is unknown", { nodes: [{ ...childNode, component: "other" }] }],
  ])("%s: the cause as it is, nothing marked", async (_case, options) => {
    const { deps, trees } = depsOf(options);

    await markTreeUnwinding(deps, STATE, new Error("declined"));
    const ended = await unwoundTree(deps, STATE, call());

    expect(ended.compensations).toEqual([]);
    expect(mocks.unwound).not.toHaveBeenCalled();
    expect(await unwindingOf(trees, TREE, UNWINDING_KEY)).toBeUndefined();
  });

  it("a child's workflow that declares an undo makes the tree undoable", async () => {
    const { deps, trees } = depsOf({ nodes: [plain, childNode], child: [undoable] });

    await markTreeUnwinding(deps, STATE, new Error("declined"));

    expect(await unwindingOf(trees, TREE, UNWINDING_KEY)).toMatchObject({
      reason: CompensationReason.ExecutionFailed,
    });
  });

  it("a workflow that launches itself is looked at once", async () => {
    const { deps } = depsOf({ nodes: [plain, childNode] });
    const self = deps as unknown;
    (deps as { childDepsOf: unknown }).childDepsOf = () => self;

    await expect(unwoundTree(deps, STATE, call())).resolves.toMatchObject({ compensations: [] });
    expect(mocks.unwound).not.toHaveBeenCalled();
  });

  it("only a child node's workflow is looked at; deps that launch no children have none", async () => {
    const lookedAt: unknown[] = [];
    const undoableChild = {
      config: { name: "child-workflow" },
      graph: { nodes: new Map([["c", undoable]]) },
    };
    const { deps } = depsOf({ nodes: [{ ...plain, component: "an action" }, childNode] });
    (deps as { childDepsOf: unknown }).childDepsOf = (component: unknown) => {
      lookedAt.push(component);
      return component === "an action" ? undoableChild : undefined;
    };
    const bare = depsOf({ nodes: [childNode] }).deps;
    (bare as { childDepsOf: unknown }).childDepsOf = undefined;

    await unwoundTree(deps, STATE, call());
    await unwoundTree(bare, STATE, call());

    expect(lookedAt).toEqual(["child"]);
    expect(mocks.unwound).not.toHaveBeenCalled();
  });
});

describe("#633: a tree with an undo", () => {
  it("its checkpoint's entries through the marks, all covered, undone under the call's lease", async () => {
    const { deps, trees } = depsOf({ nodes: [undoable], owner: "alice" });
    await markUndone({ trees, tree: TREE }, closedOf(entryOf("done")));
    mocks.entriesInCheckpoint.mockResolvedValue([
      { namespace: "", executionId: "root-1", entries: [entryOf("done"), entryOf("open")] },
    ]);
    const lease = call();

    const ended = await unwoundTree(deps, STATE, lease);
    const unwind = unwindAsked();

    expect(unwind.known.map((entry) => [entry.key, entry.status])).toEqual([
      ["done", "closed"],
      ["open", "open"],
    ]);
    expect([unwind.covers(entryOf("x")), unwind.runs({} as never), unwind.isSealing]).toEqual([
      true,
      true,
      true,
    ]);
    expect(unwind.timeout).toBe(seconds(4));
    const site = unwind.undoSiteOf(entryOf("open"));
    expect(site.execution.lease).toBe(lease.lease);
    expect(site.execution.ownerId).toBe("alice");
    expect(ended.error).toBe(lease.cause);
    expect(ended.compensations.map((record) => record.status)).toEqual([
      CompensationStatus.Compensated,
      CompensationStatus.Compensated,
    ]);
  });

  it("an undo that failed: CompensationFailedError, caused by the original", async () => {
    const { deps } = depsOf({ nodes: [undoable] });
    const failure = closedOf(entryOf("open"), CompensationStatus.Failed).undo;
    mocks.unwound.mockResolvedValue({ closed: [], usage: [], failures: [failure] });
    const ending = call();

    const ended = await unwoundTree(deps, STATE, ending);

    expect(ended.error).toBeInstanceOf(CompensationFailedError);
    expect((ended.error as CompensationFailedError).cause).toBe(ending.cause);
  });

  it("no pause store, no compensation parts, no owner: nothing read, the default bound", async () => {
    const { deps } = depsOf({ nodes: [undoable], pause: false, compensation: false });

    await unwoundTree(deps, STATE, call());

    expect(mocks.entriesInCheckpoint).not.toHaveBeenCalled();
    expect(unwindAsked().known).toEqual([]);
    expect(unwindAsked().timeout).toBe(COMPENSATION_TIMEOUT);
    expect(unwindAsked().undoSiteOf(entryOf("x")).execution.ownerId).toBeUndefined();
  });

  it("budgets but none kept in the checkpoint: the spend is written to none", async () => {
    mocks.treeStateOf.mockResolvedValue({});
    const { deps } = depsOf({ nodes: [undoable], budgets: true });

    await unwoundTree(deps, STATE, call());

    await expect(unwindAsked().record([USAGE])).resolves.toBeUndefined();
  });

  it("an undo the registry mirrors that the checkpoint missed: listed in the records", async () => {
    const mirrored = closedOf(entryOf("side-path"));
    const { deps } = depsOf({ nodes: [undoable] });
    (deps.compensation as { registry: unknown }).registry = {
      entriesOf: (_tree: unknown, matches: (entry: unknown) => boolean) =>
        [mirrored].filter(matches),
    };

    const ended = await unwoundTree(deps, STATE, call());

    expect(ended.compensations).toEqual([mirrored.undo]);
  });

  it("the undo's spend: written at once to the budgets its checkpoint keeps; none without budgets", async () => {
    const budget = {
      budget: { name: "tenant-budget" },
      scope: BudgetScope.Tenant,
      key: "acme",
      maxSpend: 5,
      period: "day",
    };
    mocks.treeStateOf.mockResolvedValue({ budgets: [budget] });
    const { deps, ledger } = depsOf({ nodes: [undoable], budgets: true });
    const counter = { budget: "tenant-budget", scope: BudgetScope.Tenant, key: "acme" };
    const before = await ledger.findSpentByCounter({ ...counter, period: "" });

    await unwoundTree(deps, STATE, call());
    await unwindAsked().record([USAGE]);

    expect(before).toBe(0);
    const periodOf = (await import("../../../src/budgets/budget-period.js")).periodStartOf;
    const spent = await ledger.findSpentByCounter({
      ...counter,
      period: periodOf("day" as never, new VirtualClock().now()),
    });
    expect(spent).toBeCloseTo(0.5);
  });
});
