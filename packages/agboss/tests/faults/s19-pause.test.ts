import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FaultInvariant, FaultInvariantError, faultSuite } from "../../src/testing/faults/index.js";
import { runFaultScenario, type RunnableFaultScenario } from "../../src/testing/faults/scenario.js";
import {
  s19Paused,
  s19bAnswering,
  s19cResuming,
} from "../../src/testing/faults/scenarios/s19-pause.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #959 AC3 — scenario 19 — a pod killed around a pause: while the tree is paused, right after its
 * resume recorded the answer, and while the resumed pass runs; on SQLite pods (one file, several
 * processes).
 */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: ["s19-pause-kill-paused", "s19b-pause-kill-answering", "s19c-pause-kill-resuming"],
});

/**
 * #959 AC3 — the pause scenarios bite: on a record store that forgets a resting root's
 * `paused → running` mark, or a pause store that loses the answer it said it recorded, 19b's tree
 * is never continued — it never finishes (trees-finish), and its pause stays unanswered.
 */
interface Sabotage {
  readonly scenario: RunnableFaultScenario;
  readonly orderId: string;
  readonly store: string;
  readonly module: string;
}

const SABOTAGES: readonly Sabotage[] = [
  {
    scenario: s19Paused,
    orderId: "o-19",
    store: "a pause store that keeps no paused run",
    module: "lost-run",
  },
  {
    scenario: s19bAnswering,
    orderId: "o-19b",
    store: "a record store that forgets the root's mark",
    module: "forgetful-mark",
  },
  {
    scenario: s19bAnswering,
    orderId: "o-19b",
    store: "a pause store that loses the answer it recorded",
    module: "lost-answer",
  },
  {
    scenario: s19cResuming,
    orderId: "o-19c",
    store: "a record store that forgets the root's mark",
    module: "forgetful-mark",
  },
];

describe("#959 AC3: the pause scenarios fail on a sabotage store", () => {
  it.each(
    SABOTAGES.map(
      (sabotage) => [`${sabotage.scenario.id} on ${sabotage.store}`, sabotage] as const,
    ),
  )(
    "%s: its tree never finishes (trees-finish)",
    async (_name, { scenario, orderId, module }) => {
      const target = sqliteFaultTarget(
        fileURLToPath(new URL(`./${module}.fault-stores.ts`, import.meta.url)),
      );

      const failure: unknown = await runFaultScenario(scenario, target).catch(
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(FaultInvariantError);
      const { violations } = failure as FaultInvariantError;
      expect(violations.map((one) => one.invariant)).toContain(FaultInvariant.TreesFinish);
      expect(violations.map((one) => one.message)).toContainEqual(
        expect.stringMatching(new RegExp(`^${orderId} never finished`, "u")),
      );
    },
    120_000,
  );
});
