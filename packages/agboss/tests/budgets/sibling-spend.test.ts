/**
 * #776 — a child on any instance is queued only once the tree's spend so far is in the ledger (#732),
 * also spend a sibling branch makes after the launching step's own checkpoint, which the checkpoint
 * gating (`SettledSpendCheckpointSaver`) does not hold back: the `settled()` in `remoteChildEndOf`.
 * Item `a` pays $60 (its write held by the ledger) while item `b`'s grandchild on any instance is
 * about to be queued: the grandchild waits for the write, then its second $50 is held back at $110.
 * Without that `settled()` it is queued at once, and its worker pays $50 twice beside the pending
 * $60 — $160 of $100.
 */
import { afterEach, describe, expect } from "vitest";
import { BudgetScope } from "../../src/budgets/budget.js";
import { counterOf } from "../../src/budgets/execution-budgets.js";
import { CostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import { TestConcurrency, testWith } from "../../src/testing/index.js";
import { readyAll } from "../app/fixtures/child-end-freeze.js";
import { instance } from "../app/fixtures/fence-takeover.js";
import { execute } from "../helpers/flow.js";
import {
  resetSiblingSpend,
  siblingSpend,
  SiblingItemsWorkflowStart,
  SiblingSpendApplication,
} from "./fixtures/sibling-spend.workflow.js";

const two = testWith(SiblingSpendApplication, { instances: 2, concurrency: TestConcurrency.Real });

let release = (): void => undefined;

afterEach(() => {
  release();
});

type Outcome = { readonly error: unknown } | { readonly done: true };

describe("#776: a sibling's spend in flight, a grandchild on any instance about to be queued", () => {
  two(
    "the grandchild is queued once a's $60 is in the ledger: its second $50 held back at $110",
    async ({ apps, clock }) => {
      ({ release } = resetSiblingSpend());
      await readyAll(apps);
      const app = instance(apps, 0);
      const run: Promise<Outcome> = execute(app, SiblingItemsWorkflowStart, [
        { name: "a", delay: 0, outcome: "ok" },
        { name: "b", delay: 0, outcome: "ok" },
      ]).then(
        () => ({ done: true }) as const,
        (error: unknown) => ({ error }),
      );
      for (let i = 0; i < 40 && !siblingSpend.ran.includes("a:sibling-pay"); i += 1)
        await clock.advance("1s");
      for (let i = 0; i < 20; i += 1) await clock.advance("1s");

      // a paid while b's grandchild was about to be queued; its write is still held
      expect(siblingSpend.ran).toEqual(["a:sibling-pay"]);
      expect(siblingSpend.isPayWritten).toBe(false);

      release();
      for (let i = 0; i < 40 && !siblingSpend.ran.includes("b:grand-one"); i += 1)
        await clock.advance("1s");
      const outcome = await run;

      expect("error" in outcome ? outcome.error : outcome).toMatchObject({
        name: "BudgetExceededError",
        message: expect.stringContaining("spent $110;"),
      });
      expect(siblingSpend.ran).toEqual(["a:sibling-pay", "b:grand-one"]);
      const ledger = app.resolve(CostLedgerRepository);
      const executionId = /execution (\S+) spent/u.exec(
        String("error" in outcome ? outcome.error : ""),
      )?.[1];
      const execution = {
        budget: { name: "test-execution-budget" },
        scope: BudgetScope.Execution,
        key: executionId ?? "",
        maxSpend: 0,
      };
      expect(await ledger.findSpentByCounter(counterOf(execution, clock.now()))).toBe(110);
    },
  );
});
