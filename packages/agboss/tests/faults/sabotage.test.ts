/**
 * #484 AC4 — the scenarios bite: each runs on a deliberately broken store set and fails on the
 * invariant the store breaks (a permanent negative test; the same scenarios pass on the real set,
 * s05-zombie.test.ts and s06-children.test.ts).
 *
 * - no fencing check on the business write (`UnfencedSqliteFencedEffectRepository`): scenario 5b's
 *   zombie writes the charge at its stale token after the new holder was granted the lease — one
 *   owner per tree is broken;
 * - a `retire` that is a plain `release` (`ReleasingSqliteExecutionLeaseRepository`, #520):
 *   scenario 6b's frozen pod is granted the finished child's lease — finished work is touched;
 * - no fencing check on the payment's intent (`UnfencedSqliteOutboundCallRepository`, #584):
 *   scenario 5c's zombie records its payment at its stale token after the new holder was granted
 *   the lease — one owner per tree is broken;
 * - a lease renewal that says yes to a lease that is over (`StaleRenewingSqliteExecutionLeaseRepository`,
 *   #608): scenario 5d's zombie, frozen between its payment's intent and its send, passes its
 *   `renewNow()` after the new holder paid and sends the payment a second time;
 * - a business write that accepts a forged token (`ForgedTokenSqliteFencedEffectRepository`, #840):
 *   scenario 1's charge is accepted at a token no lease was granted at — one owner per tree is
 *   broken, though no grant of a newer epoch came before it;
 * - a business write that lets a stale token through at the lease's current epoch and kills its
 *   pod before the answer (`staleThenKilled`, #876, #959: built from any set's store, run by every
 *   set's suite): 5e's zombie writes the charge and dies unanswered — one owner per tree is
 *   broken, as the store's row tells, though the new holder replays it;
 * - a tree store that forgets every undo's done mark (`ForgetfulSqliteExecutionTreeRepository`,
 *   #607): scenario 12b's next pod releases the reservation the frozen one released and marked.
 *
 * #533 item 5: every run's store history also fails the linearizability checker (`linearizable`).
 *
 * #811 AC4 — the A2A scenarios bite (`broken-a2a-stores.ts`):
 * - a lease store that says "kept" to an id kept before (`KeepingAgainSqliteExecutionLeaseRepository`):
 *   17's and 17b's read repair fence nothing — the task's id kept twice, and the thawed start runs
 *   the task settled start-lost;
 * - a tree store that never reads a cancel request back (`CancelBlindSqliteExecutionTreeRepository`):
 *   17b's thawed start runs past its tree's cancel; 18's running pass is never stopped, and let go
 *   after two leases it charges and pays more than a lease after the cancel request; 18c's resumed
 *   tree, which the cancel finds running again (#850), completes though its cancel was accepted;
 * - that store resolving a withdrawn pause too (`StalePausesSqlitePausedExecutionRepository`): 18b's
 *   resume after the cancel runs, and the reservation is undone twice.
 *
 * #657, #658 — the payment's own integration broken, on the real store set: every gateway error
 * taken for a definite failure (as before #657), scenario 14's lost answer is resent after the
 * gateway forgot its key; no key retention declared (#658), scenario 15's replay of an expired key
 * is a new charge — each fails effects-once with a second payment.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FaultInvariant, FaultInvariantError } from "../../src/testing/faults/index.js";
import { runFaultScenario, type RunnableFaultScenario } from "../../src/testing/faults/scenario.js";
import {
  s05ZombieFirst,
  s05ZombiePaysFirst,
} from "../../src/testing/faults/scenarios/s05-zombie.js";
import { s01Drains } from "../../src/testing/faults/scenarios/s01-sigterm.js";
import { s05eZombieDiesUnanswered } from "../../src/testing/faults/scenarios/s05e-unanswered.js";
import { s06FinishedChild } from "../../src/testing/faults/scenarios/s06-children.js";
import { s05ZombieRecordedNotSent } from "../../src/testing/faults/scenarios/s05d-recorded-not-sent.js";
import { s12bMarkedUndo } from "../../src/testing/faults/scenarios/s12b-marked-undo.js";
import {
  s14EveryErrorDefinite,
  s15TrustedAsLookup,
} from "../../src/testing/faults/scenarios/s14-s15-key-expiry.js";
import {
  s17AcceptCrash,
  s17bIdKeptCrash,
} from "../../src/testing/faults/scenarios/s17-a2a-accept-crash.js";
import {
  s18bCancelFirst,
  s18cResumedNotRun,
  s18dDrainTookAnswer,
  s18ResumeFirst,
} from "../../src/testing/faults/scenarios/s18-a2a-resume-vs-cancel.js";
import {
  s20bCancelAtPayment,
  s20CancelAtCharge,
} from "../../src/testing/faults/scenarios/s20-cancel-at-payment.js";
import { StoreHoldPoint } from "../../src/testing/faults/store-points.js";
import {
  expectThat,
  heldAt,
  holdStore,
  release,
  startOrder,
  takenOverBy,
} from "../../src/testing/faults/scenarios/kit.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

const unfenced = sqliteFaultTarget(
  fileURLToPath(new URL("./unfenced.fault-stores.ts", import.meta.url)),
);
const unfencedCalls = sqliteFaultTarget(
  fileURLToPath(new URL("./unfenced-calls.fault-stores.ts", import.meta.url)),
);
const staleRenewing = sqliteFaultTarget(
  fileURLToPath(new URL("./stale-renewing.fault-stores.ts", import.meta.url)),
);
const forgetful = sqliteFaultTarget(
  fileURLToPath(new URL("./forgetful-marks.fault-stores.ts", import.meta.url)),
);
const forgedToken = sqliteFaultTarget(
  fileURLToPath(new URL("./forged-token.fault-stores.ts", import.meta.url)),
);
const keepingAgain = sqliteFaultTarget(
  fileURLToPath(new URL("./keeping-again.fault-stores.ts", import.meta.url)),
);
const cancelBlind = sqliteFaultTarget(
  fileURLToPath(new URL("./cancel-blind.fault-stores.ts", import.meta.url)),
);
const stalePauses = sqliteFaultTarget(
  fileURLToPath(new URL("./stale-pauses.fault-stores.ts", import.meta.url)),
);
const endBlind = sqliteFaultTarget(
  fileURLToPath(new URL("./end-blind.fault-stores.ts", import.meta.url)),
);
const unmarked = sqliteFaultTarget(
  fileURLToPath(new URL("./unmarked.fault-stores.ts", import.meta.url)),
);
const releasing = sqliteFaultTarget(
  fileURLToPath(new URL("./releasing-retire.fault-stores.ts", import.meta.url)),
);

/** What `scenario` failed with on `target`; the test fails when it passed. */
async function failureOf(
  scenario: RunnableFaultScenario,
  target: typeof unfenced,
): Promise<FaultInvariantError> {
  const error: unknown = await runFaultScenario(scenario, target).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error, String(error)).toBeInstanceOf(FaultInvariantError);
  return error as FaultInvariantError;
}

describe("#484 AC4: a broken store fails the scenario that targets it", () => {
  it("no fencing check on the business write: 5b fails one-owner — the zombie's stale write accepted", async () => {
    const failure = await failureOf(s05ZombieFirst, unfenced);
    expect(failure.invariants).toContain(FaultInvariant.OneOwner);
    // #533 item 5: the recorded history has no order the sequential model explains
    expect(failure.invariants).toContain(FaultInvariant.Linearizable);
    expect(failure.violations.map((found) => found.message)).toContainEqual(
      expect.stringMatching(
        /fencedEffect\.write .* at token 1 .* was accepted after epoch 2 was granted/u,
      ),
    );
  }, 120_000);

  it("#840 AC2: a business write that accepts a forged token: 1 fails one-owner — a write no grant explains", async () => {
    const failure = await failureOf(s01Drains, forgedToken);
    expect(failure.invariants).toContain(FaultInvariant.OneOwner);
    expect(
      failure.violations
        .filter((found) => found.invariant === FaultInvariant.OneOwner)
        .map((found) => found.message),
    ).toContainEqual(
      expect.stringMatching(
        /^fencedEffect\.write of \S+ at token 1000001 \(\S+, \S+\) was accepted, but no lease of \S+ was granted at epoch 1000001$/u,
      ),
    );
  }, 120_000);

  it("#876, #959 AC4-AC6: a stale write let through at the current epoch, its pod killed before the answer: 5e fails one-owner on the store's row, though the new holder replayed it", async () => {
    const failure = await failureOf(s05eZombieDiesUnanswered, sqliteFaultTarget());
    expect(
      failure.violations
        .filter((found) => found.invariant === FaultInvariant.OneOwner)
        .map((found) => found.message),
    ).toContainEqual(expect.stringMatching(s05eZombieDiesUnanswered.evidence));
    expect(failure.invariants).toContain(FaultInvariant.Linearizable);
  }, 120_000);

  it("a finish that is a plain release: 6b fails finished-work-untouched — the finished child's lease granted again", async () => {
    const failure = await failureOf(s06FinishedChild, releasing);
    expect(failure.invariants).toContain(FaultInvariant.FinishedWorkUntouched);
    expect(failure.invariants).toContain(FaultInvariant.Linearizable);
  }, 120_000);

  it("no fencing check on the payment's intent: 5c fails one-owner — the zombie's stale intent accepted", async () => {
    const failure = await failureOf(s05ZombiePaysFirst, unfencedCalls);
    expect(failure.invariants).toContain(FaultInvariant.OneOwner);
    expect(failure.violations.map((found) => found.message)).toContainEqual(
      expect.stringMatching(
        /outboundCall\.saveIfAbsent .* at token 1 .* was accepted after epoch 2 was granted/u,
      ),
    );
    expect(failure.invariants).toContain(FaultInvariant.Linearizable);
  }, 120_000);

  it("a renewal that says yes to a lease that is over: 5d's zombie sends the payment again — it fails effects-once", async () => {
    const failure = await failureOf(s05ZombieRecordedNotSent, staleRenewing);
    expect(failure.invariants).toContain(FaultInvariant.EffectsOnce);
    expect(failure.violations.map((found) => found.message)).toContainEqual(
      expect.stringMatching(/o-5d reached the gateway 2 times \(from b, a\)/u),
    );
    // the stale renewal accepted after epoch 2 was granted: no sequential order explains it
    expect(failure.invariants).toContain(FaultInvariant.Linearizable);
  }, 120_000);

  it("a tree store that forgets an undo's done mark: 12b's next pod releases again — it fails no-undo-on-hand-over", async () => {
    const failure = await failureOf(s12bMarkedUndo, forgetful);
    expect(failure.invariants).toContain(FaultInvariant.NoUndoOnHandOver);
    expect(failure.violations.map((found) => found.message)).toContainEqual(
      expect.stringMatching(
        /o-12b declined, and its reservation was released 2 times \(on a, b\)/u,
      ),
    );
  }, 120_000);

  it("#657 AC2: every gateway error taken for a definite failure: 14's lost answer is resent past the key — two payments", async () => {
    const failure = await failureOf(s14EveryErrorDefinite, sqliteFaultTarget());
    expect(failure.invariants).toContain(FaultInvariant.EffectsOnce);
    expect(failure.violations.map((found) => found.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/o-14 reached the gateway 2 times \(from a, b\)/u),
        "o-14 was paid 2 times at the gateway",
      ]),
    );
  }, 120_000);

  it("#658, #795: a key replay trusted as a lookup: 15's replay of an expired key is a new charge — two payments", async () => {
    const failure = await failureOf(s15TrustedAsLookup, sqliteFaultTarget());
    expect(failure.invariants).toContain(FaultInvariant.EffectsOnce);
    expect(failure.violations.map((found) => found.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/o-15 reached the gateway 2 times \(from a, b\)/u),
        "o-15 was paid 2 times at the gateway",
      ]),
    );
  }, 120_000);
});

describe("#909 AC2/AC3: a cancel that fences nothing fails the scenarios that target it", () => {
  const UNFENCED =
    /^tree \S+ committed (fencedEffect\.write|outboundCall\.saveIfAbsent) \(a\) after its cancel was durable$/u;

  it("a cancel mark that never lands: 19's charge runs after the cancel — no-effect-after-cancel", async () => {
    const failure = await failureOf(s20CancelAtCharge, unmarked);
    expect(failure.invariants).toContain(FaultInvariant.NoEffectAfterCancel);
    expect(failure.violations.map((found) => found.message)).toContainEqual(
      expect.stringMatching(UNFENCED),
    );
  }, 180_000);

  it("a cancel mark that never lands: 19b's payment is sent after the cancel — no-effect-after-cancel", async () => {
    const failure = await failureOf(s20bCancelAtPayment, unmarked);
    expect(failure.invariants).toContain(FaultInvariant.NoEffectAfterCancel);
    expect(failure.notes.join("\n")).toMatch(
      /was to be refused \(ExecutionCancelFencedError\); it was accepted/u,
    );
  }, 180_000);
});

/** The messages of `failure`'s violations of one-execution-per-A2A-task. */
const a2aMessagesOf = (failure: FaultInvariantError): readonly string[] =>
  failure.violations
    .filter((found) => found.invariant === FaultInvariant.A2ATasksOnce)
    .map((found) => found.message);

/** A task settled start-lost that ran the order's steps anyway. */
const RAN_START_LOST =
  /^task \S+ was settled a2a\.start-lost, yet ran reserve on a, charge\.before on a/u;

/** The task's id kept twice — b's fence and a's start — the second start under one task. */
const KEPT_TWICE =
  /^execution id \S+ was kept 2 times \(by [ab], [ab]\): two starts under one task$/u;

describe("#811 AC4: a broken store fails the A2A scenario that targets it", () => {
  it("a lease store that keeps an id twice: 17's fence fences nothing — the id kept twice, the start-lost task run", async () => {
    const failure = await failureOf(s17AcceptCrash, keepingAgain);
    expect(a2aMessagesOf(failure)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(KEPT_TWICE),
        expect.stringMatching(RAN_START_LOST),
      ]),
    );
  }, 120_000);

  it("a lease store that keeps an id twice: 17b's fence wins over the kept id — kept twice, the frozen start runs", async () => {
    const failure = await failureOf(s17bIdKeptCrash, keepingAgain);
    expect(a2aMessagesOf(failure)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(KEPT_TWICE),
        expect.stringMatching(RAN_START_LOST),
      ]),
    );
  }, 120_000);

  it("a tree store blind to cancel requests: 17b's thawed start runs past its tree's cancel", async () => {
    const failure = await failureOf(s17bIdKeptCrash, cancelBlind);
    expect(a2aMessagesOf(failure)).toContainEqual(expect.stringMatching(RAN_START_LOST));
  }, 120_000);

  // #909: the cancel's mark is a fence of its own — the store refuses the let-go charge in the
  // lease's transaction whatever the tree store shows — so nothing is committed past the cancel and
  // no invariant bites; the scenario's own check that the request stopped the pass still does
  it("a tree store blind to cancel requests: 18's pass is never stopped by the request — and its let-go charge is refused by the cancel's mark, nothing committed past the cancel", async () => {
    await expect(runFaultScenario(s18ResumeFirst, cancelBlind)).rejects.toThrow(
      /^s18-a2a-resume-vs-cancel: a's pass was not stopped within two leases of the cancel: its charge was let go$/u,
    );
  }, 120_000);

  it("#909: a tree store blind to cancel requests no longer lets 18c's resumed tree complete — the cancel's mark refuses its charge, CANCELED", async () => {
    await expect(runFaultScenario(s18cResumedNotRun, cancelBlind)).resolves.toBeDefined();
  }, 120_000);

  // #901: the late resume reads the tree's failed record at its take, so the stale pause it took
  // runs nothing (no second undo); what the store did is still seen — both moved the one pause, and
  // the refusal it gave says the pause was not cancelled (#939's check of its reason, s18b).
  // The released-twice rule bites on a hand-built run (tests/testing/faults/a2a-invariants.test.ts)
  it("a pause store that resolves a withdrawn pause and keeps the run: 18b fails — both the cancel and the late resume took the pause", async () => {
    await expect(runFaultScenario(s18bCancelFirst, stalePauses)).rejects.toThrow(
      /^s18b-a2a-cancel-vs-resume: the refusal was to be a2a\.pause-closed, cancelled: .*; the cancel was to withdraw the pause first: a's resolve \[true\], b's cancel \[true\]$/u,
    );
  }, 120_000);

  // #901: the resume's check at its take, taken away by the store (its read of the failed root
  // says running) — 18d's late resume takes the answer the cancel ended, as the core did before.
  // #909: its charge is now refused by the cancel's mark (nothing committed past the cancel, no
  // invariant), but the blind read keeps the task WORKING: the scenario's own checks bite
  it("a record store that reads a failed root as running: 18d's late resume is not refused -32004 and the task never reads CANCELED", async () => {
    await expect(runFaultScenario(s18dDrainTookAnswer, endBlind)).rejects.toThrow(
      /^s18d-a2a-drain-took-answer-cancel: the resume of the ended tree was to be -32004:/u,
    );
  }, 120_000);
});
