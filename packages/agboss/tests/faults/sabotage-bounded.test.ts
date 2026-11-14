/**
 * #1059 — the bounded scenarios bite: with the freeze pod keeping the store-call bound, as
 * production runs it, each broken store is still caught, or the bound is shown to be what shields it.
 * Each broken store is the one `sabotage.test.ts` breaks on unbounded pods.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FaultInvariant, FaultInvariantError } from "../../src/testing/faults/index.js";
import { runFaultScenario, type RunnableFaultScenario } from "../../src/testing/faults/scenario.js";
import { s05ZombieRecordedNotSentBounded } from "../../src/testing/faults/scenarios/s05d-recorded-not-sent.js";
import {
  s17AcceptCrashBounded,
  s17bIdKeptCrashBounded,
} from "../../src/testing/faults/scenarios/s17-bounded.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

const staleRenewing = sqliteFaultTarget(
  fileURLToPath(new URL("./stale-renewing.fault-stores.ts", import.meta.url)),
);
const keepingAgain = sqliteFaultTarget(
  fileURLToPath(new URL("./keeping-again.fault-stores.ts", import.meta.url)),
);
const cancelBlind = sqliteFaultTarget(
  fileURLToPath(new URL("./cancel-blind.fault-stores.ts", import.meta.url)),
);

/** What `scenario` failed with on `target`; the test fails when it passed. */
async function failureOf(
  scenario: RunnableFaultScenario,
  target: typeof staleRenewing,
): Promise<FaultInvariantError> {
  const error: unknown = await runFaultScenario(scenario, target).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error, String(error)).toBeInstanceOf(FaultInvariantError);
  return error as FaultInvariantError;
}

/** The messages of `failure`'s violations of one-execution-per-A2A-task. */
const a2aMessagesOf = (failure: FaultInvariantError): readonly string[] =>
  failure.violations
    .filter((found) => found.invariant === FaultInvariant.A2ATasksOnce)
    .map((found) => found.message);

/** The task's id kept more than once: b's fence, a's late claim, a's refusal check. */
const KEPT_AGAIN =
  /^execution id \S+ was kept \d times \(by [ab], [ab](, [ab])*\): two starts under one task$/u;

describe("#1059: the bounded scenarios on broken stores", () => {
  it("a lease store that says yes to a renewal of a lease that is over: bounded 5d fails linearizable — the zombie's overdue renewal accepted; it never reaches the send", async () => {
    const failure = await failureOf(s05ZombieRecordedNotSentBounded, staleRenewing);
    // the bound gives the zombie's held intent up before its renewNow, so no second payment: the
    // renewal it still sends on the thaw is what the history shows, accepted after epoch 2
    expect(failure.invariants).toContain(FaultInvariant.Linearizable);
    expect(failure.invariants).not.toContain(FaultInvariant.EffectsOnce);
    expect(failure.violations.map((found) => found.message)).toContainEqual(
      expect.stringMatching(/lease\.renew by a-\d+ .* → \d+/u),
    );
  }, 120_000);

  it("a lease store that keeps an id twice: bounded 17's late claim is kept again — the id kept more than once", async () => {
    const failure = await failureOf(s17AcceptCrashBounded, keepingAgain);
    expect(a2aMessagesOf(failure)).toContainEqual(expect.stringMatching(KEPT_AGAIN));
  }, 120_000);

  it("a lease store that keeps an id twice: bounded 17b's fence wins over the kept id — the id kept more than once", async () => {
    const failure = await failureOf(s17bIdKeptCrashBounded, keepingAgain);
    expect(a2aMessagesOf(failure)).toContainEqual(expect.stringMatching(KEPT_AGAIN));
  }, 120_000);

  // the bound is what shields it: the thawed start of a bounded pod is given up before it can read
  // the tree's cancel request, so a store blind to it changes nothing the scenario or an invariant
  // sees. The unbounded 17b (sabotage.test.ts) is the run that bites it.
  it("a tree store blind to cancel requests: bounded 17b passes — its thawed start is given up before it reads the cancel request", async () => {
    await expect(runFaultScenario(s17bIdKeptCrashBounded, cancelBlind)).resolves.toBeDefined();
  }, 120_000);
});
