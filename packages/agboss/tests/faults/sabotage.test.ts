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
 * - a business write that lets a stale token through and kills its pod before the answer
 *   (`KilledAfterStaleSqliteFencedEffectRepository`, #876): 5e's zombie writes the charge at its
 *   stale token and dies unanswered — one owner per tree is broken, as the store's row tells;
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
  s18ResumeFirst,
} from "../../src/testing/faults/scenarios/s18-a2a-resume-vs-cancel.js";
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
const killedAfterStale = sqliteFaultTarget(
  fileURLToPath(new URL("./killed-after-stale.fault-stores.ts", import.meta.url)),
);
const releasing = sqliteFaultTarget(
  fileURLToPath(new URL("./releasing-retire.fault-stores.ts", import.meta.url)),
);

/**
 * #876: 5b's zombie, thawed, writes the charge before the new holder; on a store that lets its
 * stale token through and kills it before the answer, the write is held only by the store's row.
 */
const s05eZombieDiesUnanswered: RunnableFaultScenario = {
  id: "s05e-zombie-dies-unanswered",
  title:
    "5e: the zombie's stale charge is let through and its pod dies before the answer — the new holder replays it",
  run: async (cluster) => {
    const point = StoreHoldPoint.FencedEffectWrite;
    const a = await cluster.pod("a");
    const b = await cluster.pod("b");
    await holdStore(a, point, undefined);
    await holdStore(b, point, undefined);
    const key = (await startOrder(cluster, a, "o-5e")).rootExecutionId;
    const frozen = await heldAt(cluster, a, point, key);
    a.freeze();
    await takenOverBy(cluster, b, key);
    const second = await heldAt(cluster, b, point, key);
    a.thaw();
    // the store kills a before it answers: the release's ack dies with it (an ack: a lives)
    const acked = await release(a, frozen).then(
      () => true,
      () => false,
    );
    await (acked ? Promise.resolve() : a.exited);
    expectThat(
      cluster,
      !acked && !a.isRunning,
      "a's stale write was to kill a before its answer; a runs",
    );
    await release(b, second);
    await cluster.ended(key);
    return b;
  },
};

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

  it("#876 AC2: a stale business write let through, its pod killed before the answer: 5e fails one-owner — the store's row holds it", async () => {
    const failure = await failureOf(s05eZombieDiesUnanswered, killedAfterStale);
    expect(
      failure.violations
        .filter((found) => found.invariant === FaultInvariant.OneOwner)
        .map((found) => found.message),
    ).toContainEqual(
      expect.stringMatching(
        /^fencedEffect\.write of \S+ at token 1 \(\S+\) was accepted after epoch 2 was granted to \S+: a stale write \(never answered: its pod died before the answer, and the store's row holds the write at token 1\)$/u,
      ),
    );
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

  it("a tree store blind to cancel requests: 18's pass, never stopped and let go, charges and pays past a lease after the cancel", async () => {
    const failure = await failureOf(s18ResumeFirst, cancelBlind);
    expect(a2aMessagesOf(failure)).toContainEqual(
      expect.stringMatching(
        /^task \S+ committed fencedEffect\.write by a, outboundCall\.saveIfAbsent by a more than a lease after its tree's cancel request: its holder never read it$/u,
      ),
    );
    expect(failure.notes).toContain(
      "a's pass was not stopped within two leases of the cancel: its charge was let go",
    );
  }, 120_000);

  it("a tree store blind to cancel requests: 18c's resumed tree, its cancel accepted, completes", async () => {
    // within its lease of the request, so no invariant's: the scenario's own check of the end
    await expect(runFaultScenario(s18cResumedNotRun, cancelBlind)).rejects.toThrow(
      /^s18c-a2a-resumed-cancel-before-pass: the task ended \{[^}]*"state":"TASK_STATE_COMPLETED"\} after its cancel request$/u,
    );
  }, 120_000);

  it("a pause store that resolves a withdrawn pause and keeps the run: 18b's resume after the cancel runs — undone twice", async () => {
    const failure = await failureOf(s18bCancelFirst, stalePauses);
    expect(a2aMessagesOf(failure)).toContainEqual(
      expect.stringMatching(/^task \S+ was canceled, and its reservation was released 2 times$/u),
    );
  }, 120_000);
});
