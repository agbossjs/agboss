/**
 * #685 — every dollar of a tree is counted once against its budgets, wherever it was spent: the
 * root, children per item on this instance and on any instance (each with a child of its own
 * here), a recursion on either. Random trees (fast-check) on a ledger whose round trips take a few
 * turns of the event loop, as a networked one's do: the ledger's three counters (execution, tenant,
 * application) each end at the sum of the payments, which is `spend.totalUsd`; a tree whose budget
 * is a cent above its plan finishes (a dollar counted twice would stop it), and a budget that the
 * spend before a step reaches holds that step back, naming the true spend (a dollar not counted
 * would let it run).
 */
import fc from "fast-check";
import { beforeEach, describe, expect } from "vitest";
import { BudgetExceededError, type Class } from "../../src/index.js";
import { BudgetPeriod, BudgetScope } from "../../src/budgets/budget.js";
import { counterOf, type ExecutionBudgetRecord } from "../../src/budgets/execution-budgets.js";
import { testWith, type TestApp } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { seededProperties } from "../helpers/property-seed.js";
import {
  resetSpendTree,
  spendTree,
  SpendTreeLedger,
  type SpendLevel,
} from "./fixtures/spend-tree.actions.js";
import {
  RemoteSpendTreeWorkflowStart,
  SpendTreeApplication,
  SpendTreeWorkflowStart,
} from "./fixtures/spend-tree.workflow.js";

const seed = seededProperties("spend-once.test.ts");
const test = testWith(SpendTreeApplication);

beforeEach(() => {
  resetSpendTree({ cents: 0, local: [], remote: [], afterCents: 0, closeCents: 0 }, 1_000_000);
});

const cents = fc.integer({ min: 0, max: 3000 });
const children = fc.array(fc.integer({ min: 1, max: 3000 }), { maxLength: 3 });

/** A level of the tree and up to `3 - depth` below it. */
const levelArbitrary = (depth: number): fc.Arbitrary<SpendLevel> =>
  fc.record({
    cents,
    local: children,
    remote: children,
    afterCents: cents,
    closeCents: cents,
    next:
      depth >= 3
        ? fc.constant(undefined)
        : fc.option(levelArbitrary(depth + 1), { nil: undefined }),
  });

const lagArbitrary = fc.integer({ min: 0, max: 3 });

const levelsOf = (root: SpendLevel): readonly SpendLevel[] =>
  root.next === undefined ? [root] : [root, ...levelsOf(root.next)];

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

/** What a level pays up to its step after its children, that step included, in cents. */
const openCents = (level: SpendLevel): number =>
  level.cents + sum(level.local) + sum(level.remote) + level.afterCents;

/** What a level pays once the next level returned: its close (none on the last level). */
const closeCents = (level: SpendLevel): number => (level.next === undefined ? 0 : level.closeCents);

/** Everything the plan pays, in cents. */
const plannedCents = (root: SpendLevel): number =>
  sum(levelsOf(root).map((level) => openCents(level) + closeCents(level)));

/** A step of one level that pays and that a check precedes: after its children, or its close. */
enum PaidStep {
  After = "after",
  Close = "close",
}

/**
 * What the tree spends before level `index`'s step: the levels open in order, each closing after
 * the next returned — so before a close every level is open and the deeper ones closed.
 */
const spentBefore = (root: SpendLevel, index: number, step: PaidStep): number => {
  const levels = levelsOf(root);
  const level = levels[index] ?? root;
  if (step === PaidStep.Close)
    return sum(levels.map(openCents)) + sum(levels.slice(index + 1).map(closeCents));
  const earlier = sum(levels.slice(0, index).map(openCents));
  return earlier + level.cents + sum(level.local) + sum(level.remote);
};

/** The plan with level `index`'s step paying at least a cent more. */
const paying = (root: SpendLevel, index: number, step: PaidStep): SpendLevel => {
  if (index > 0)
    return {
      ...root,
      next: root.next === undefined ? undefined : paying(root.next, index - 1, step),
    };
  return step === PaidStep.After
    ? { ...root, afterCents: root.afterCents + 1 }
    : { ...root, closeCents: root.closeCents + 1 };
};

/** A tree, one of its levels and one of that level's paid steps (a close only above the last). */
const treeAndStep = levelArbitrary(1).chain((root) =>
  fc
    .integer({ min: 0, max: levelsOf(root).length - 1 })
    .chain((index) =>
      fc.tuple(
        fc.constant(root),
        fc.constant(index),
        index < levelsOf(root).length - 1
          ? fc.constantFrom(PaidStep.After, PaidStep.Close)
          : fc.constant(PaidStep.After),
      ),
    ),
);

const counted = (name: string, scope: BudgetScope, key: string): ExecutionBudgetRecord =>
  scope === BudgetScope.Execution
    ? { budget: { name }, scope, key, maxSpend: 0 }
    : { budget: { name }, scope, period: BudgetPeriod.Day, key, maxSpend: 0 };

/** The three counters an execution's spend goes to, in cents. */
async function countersOf(app: TestApp, executionId: string): Promise<readonly number[]> {
  await app.ready();
  const ledger = app.resolve(SpendTreeLedger);
  const now = app.clock.now();
  const records = [
    counted("spend-tree-execution-budget", BudgetScope.Execution, executionId),
    counted("spend-tree-tenant-budget", BudgetScope.Tenant, "default"),
    counted("spend-tree-application-budget", BudgetScope.Application, "spend-tree-application"),
  ];
  return Promise.all(
    records.map(async (record) =>
      Math.round((await ledger.findSpentByCounter(counterOf(record, now))) * 100),
    ),
  );
}

/**
 * The error's `spent` in cents: the original's field, or — a remote child's error, rebuilt from its
 * record without details — the amount its sentence names (`… spent $12.34; … allows …`).
 */
function spentCentsOf(error: unknown): number {
  if (error instanceof BudgetExceededError) return Math.round(error.spent * 100);
  const named = error instanceof Error ? /spent \$([0-9.]+);/.exec(error.message)?.[1] : undefined;
  return Math.round(Number(named) * 100);
}

const starts = [
  ["on this instance", SpendTreeWorkflowStart],
  ["on any instance", RemoteSpendTreeWorkflowStart],
] as const satisfies readonly (readonly [string, Class])[];

describe(`#685: every dollar of a tree counted once (seed ${String(seed)})`, () => {
  for (const [where, startClass] of starts) {
    test(`AC1, AC2 — random trees, the recursion ${where}: under its budget it finishes, each counter at what was paid`, async ({
      app,
    }) => {
      await fc.assert(
        fc.asyncProperty(levelArbitrary(1), lagArbitrary, async (root, lag) => {
          const [, tenantBefore = 0, applicationBefore = 0] = await countersOf(app, "none");
          resetSpendTree(root, plannedCents(root) + 1, lag);

          const done = await execute(app, startClass, { path: "L1" });

          const paid = sum(spendTree.paid);
          expect(paid).toBe(plannedCents(root));
          expect(Math.round(done.spend.totalUsd * 100)).toBe(paid);
          const [execution, tenant = 0, application = 0] = await countersOf(app, done.executionId);
          expect([execution, tenant - tenantBefore, application - applicationBefore]).toEqual([
            paid,
            paid,
            paid,
          ]);
        }),
        { numRuns: 15 },
      );
    }, 120_000);

    test(`AC3 — random trees, the recursion ${where}: a level's step after its children or its close is held back, the error naming the true spend`, async ({
      app,
    }) => {
      await fc.assert(
        fc.asyncProperty(
          treeAndStep.filter(([root, index, step]) => spentBefore(root, index, step) > 0),
          lagArbitrary,
          async ([root, index, step], lag) => {
            const before = spentBefore(root, index, step);
            // half a cent below it (sums of floats drift by 1e-15); the step pays: held back (or
            // a step of no cost right before it), it pays nothing
            resetSpendTree(paying(root, index, step), before - 0.5, lag);

            const error = await execute(app, startClass, { path: "L1" }).then(
              () => undefined,
              (thrown: unknown) => thrown,
            );

            // a remote child held back fails its parent with the error as recorded: by its name
            expect(error).toMatchObject({ name: "BudgetExceededError" });
            expect(spentCentsOf(error)).toBe(before);
            expect(sum(spendTree.paid)).toBe(before);
          },
        ),
        { numRuns: 15 },
      );
    }, 120_000);
  }
});
