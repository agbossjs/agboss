/**
 * #727, #732 — a tree's spend in flight is seen by the tree's own steps on any instance: each
 * tallied spend is written to the ledger the moment it is made, and a state that holds it is
 * checkpointed only once that write landed, so a child on any instance — a sibling of a child that
 * pays and works on (#727), a child launched right after its parent paid (#732) — is held back as
 * it is on the parent's instance. The ledger counts each payment once.
 */
import { afterEach, describe, expect } from "vitest";
import { BudgetScope } from "../../src/budgets/budget.js";
import { counterOf } from "../../src/budgets/execution-budgets.js";
import { CostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import { TestConcurrency, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  AnyPayItemsWorkflowStart,
  inFlight,
  LocalPayItemsWorkflowStart,
  ParentPayWorkflowStart,
  resetInFlight,
  SpendInFlightApplication,
} from "./fixtures/spend-in-flight.workflow.js";

const test = testWith(SpendInFlightApplication, { concurrency: TestConcurrency.Real });

let release = (): void => undefined;

afterEach(() => {
  release();
});

const items = [
  { name: "a", delay: 0, outcome: "ok" as const },
  { name: "b", delay: 0, outcome: "ok" as const },
];

type Outcome = { readonly error: unknown } | { readonly done: true };
/** The root execution's id, from its error's message. */
const executionIdOf = (outcome: Outcome): string =>
  /execution (\S+) spent/u.exec("error" in outcome ? String(outcome.error) : "")?.[1] ?? "";

const outcomeOf = (run: Promise<unknown>): Promise<Outcome> =>
  run.then(
    () => ({ done: true }) as const,
    (error: unknown) => ({ error }),
  );

describe("#727: a sibling child's spend while it works on", () => {
  for (const [placement, Start] of [
    ["ParentInstance", LocalPayItemsWorkflowStart],
    ["AnyInstance", AnyPayItemsWorkflowStart],
  ] as const) {
    test(`${placement}: b's pay-three is held back at $120 while a works on`, async ({
      app,
      clock,
    }) => {
      ({ release } = resetInFlight());
      const run = outcomeOf(execute(app, Start, items));
      for (let i = 0; i < 30; i += 1) await clock.advance("1s");

      // while a works on after its $60: b's pay-one and pay-two ran, its pay-three did not
      expect(inFlight.ran).toContain("a:pay-one");
      expect(inFlight.ran.filter((step) => step.startsWith("b:"))).toEqual([
        "b:pay-one",
        "b:pay-two",
      ]);
      release();
      const outcome = await run;
      // a child on any instance fails its parent with the error as recorded: by its name
      expect("error" in outcome ? outcome.error : outcome).toMatchObject({
        name: "BudgetExceededError",
        message: expect.stringContaining("spent $120;"),
      });
      expect(inFlight.ran).not.toContain("b:pay-three");
    });
  }
});

describe("#732: a child on any instance right after its parent paid", () => {
  test("its second step is held back at $120 while the parent's write is pending; counted once", async ({
    app,
    clock,
  }) => {
    ({ release } = resetInFlight());
    const run = outcomeOf(execute(app, ParentPayWorkflowStart, items[0]));
    for (let i = 0; i < 30; i += 1) await clock.advance("1s");

    // the child is not queued before the parent's $90 is in the ledger, nor is any state that
    // holds the $90 checkpointed: a takeover never finds it marked as in the ledger and missing
    expect(inFlight.ran).toEqual(["a:parent-pay"]);
    expect(inFlight.durableBeforeLedger).toEqual([]);
    release();
    const outcome = await run;
    expect("error" in outcome ? outcome.error : outcome).toMatchObject({
      name: "BudgetExceededError",
      message: expect.stringContaining("spent $120;"),
    });
    expect(inFlight.ran).toEqual(["a:parent-pay", "a:child-one"]);

    // every counter holds each payment once
    const ledger = app.resolve(CostLedgerRepository);
    const now = clock.now();
    const execution = {
      budget: { name: "test-execution-budget" },
      scope: BudgetScope.Execution,
      key: executionIdOf(outcome),
      maxSpend: 0,
    };
    expect(await ledger.findSpentByCounter(counterOf(execution, now))).toBe(120);
  });
});
