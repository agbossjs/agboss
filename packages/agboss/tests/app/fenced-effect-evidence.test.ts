/**
 * #501 PR 3 — the fenced effect (#500) in the lease log: every call of `saveResultIfAbsent` from a
 * step is a `FencedEffect` row and an `onFencedEffect` — ran, replayed, joined or refused, never its
 * result. With the takeover (PR 1) and the hand-over (PR 2) they let a verifier tell, from
 * `app.leaseEventsOf` alone, a zombie refused at its protected write from one that never reached it
 * (AC2), and a replayed effect from a new write (AC3).
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import {
  ExecutionFencedError,
  ExecutionLeaseEventKind,
  FencedEffectEventOutcome,
  HandOverReason,
  HandOverSite,
  type ExecutionLeaseEventRecord,
} from "../../src/index.js";
import { TestConcurrency, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { logged, resetLogged } from "../helpers/log.js";
import {
  ends,
  resetRecovery,
  seen as recovery,
} from "../infrastructure/fixtures/recovery.workflow.js";
import { instance, rejectionOf, settle } from "./fixtures/fence-takeover.js";
import {
  book,
  charging,
  ChargeWorkflowStart,
  DoubleChargeWorkflowStart,
  frozenRuns,
  gates,
  letAllGo,
  resetFencedEffect,
} from "./fixtures/fenced-effect.workflow.js";
import {
  FencedEffectEventsApplication,
  leaseSeen,
  resetLeaseEvents,
  ThrowingFencedEffectObserverApplication,
} from "./fixtures/lease-events.application.js";
import type { VirtualClock, TestLeases } from "../../src/testing/index.js";

const test = testWith(FencedEffectEventsApplication);
const two = testWith(FencedEffectEventsApplication, { instances: 2 });
const real = testWith(FencedEffectEventsApplication, { concurrency: TestConcurrency.Real });
const throwing = testWith(ThrowingFencedEffectObserverApplication);

beforeEach(() => {
  resetFencedEffect();
  resetRecovery();
  resetLeaseEvents();
  resetLogged();
});

afterEach(() => {
  letAllGo();
});

/** What the public lease log of a tree says its old holder did, nothing else read. */
enum ZombieVerdict {
  /** It reached its protected write and was refused there. */
  Refused = "refused",
  /** Its lease was taken over, and it never wrote again (froze or died first). */
  NeverAttempted = "never-attempted",
  /** No takeover at all. */
  NoTakeover = "no-takeover",
}

/** The verifier of AC2: the rows of `app.leaseEventsOf` only. */
function verdictOf(rows: readonly ExecutionLeaseEventRecord[]): ZombieVerdict {
  const takeover = rows.find((row) => row.kind === ExecutionLeaseEventKind.Takeover);
  if (takeover === undefined) return ZombieVerdict.NoTakeover;
  const isRefused = rows.some(
    (row) =>
      row.kind === ExecutionLeaseEventKind.FencedEffect &&
      row.outcome === FencedEffectEventOutcome.Refused &&
      row.holderInstanceId !== takeover.holderInstanceId,
  );
  return isRefused ? ZombieVerdict.Refused : ZombieVerdict.NeverAttempted;
}

/** The kind (and outcome) of each row, in order. */
const shapeOf = (rows: readonly ExecutionLeaseEventRecord[]): readonly string[] =>
  rows.map((row) =>
    row.kind === ExecutionLeaseEventKind.FencedEffect ? `${row.kind}:${row.outcome}` : row.kind,
  );

/** The root of the first charge: the only tree of these tests. */
const rootOf = (app: TestApp, executionId: string) =>
  app.leaseEventsOf({ tenantId: "default", rootExecutionId: executionId });

/**
 * A charges an order, A freezes before its effect (`before`) or after it (`after`); its lease is
 * stalled and B's sweep recovers the tree under token 2. The call still waits.
 */
async function zombie(
  apps: readonly TestApp[],
  clock: VirtualClock,
  leases: TestLeases,
  side: "before" | "after",
): Promise<{ readonly call: Promise<unknown> }> {
  gates[side] = 1;
  const [a, b] = [instance(apps, 0), instance(apps, 1)];
  await a.ready();
  await b.ready();
  const call = execute(a, ChargeWorkflowStart, { text: "order-7" });
  call.catch(() => undefined);
  await frozenRuns(1);
  leases.stall(a);
  await clock.advance(seconds(31));
  await clock.advance(seconds(31));
  await ends(1);
  return { call };
}

/** The tree of the zombie's charge: its first execution. */
const ROOT = "execution-1";

describe("#501 AC2: a refused zombie from one that never wrote, from the public log alone", () => {
  two(
    "AC2: refused zombie → HandedOver(Fenced) + FencedEffect(Refused) after the new holder's takeover and write",
    async ({ apps, clock, leases }) => {
      const { call } = await zombie(apps, clock, leases, "before");

      letAllGo();
      await settle();
      leases.resume(instance(apps, 0));
      const error = await rejectionOf(call);
      const rows = await rootOf(instance(apps, 1), ROOT);

      expect(error).toBeInstanceOf(ExecutionFencedError);
      expect(shapeOf(rows)).toEqual([
        ExecutionLeaseEventKind.Takeover,
        `${ExecutionLeaseEventKind.FencedEffect}:${FencedEffectEventOutcome.Ran}`,
        `${ExecutionLeaseEventKind.FencedEffect}:${FencedEffectEventOutcome.Refused}`,
        ExecutionLeaseEventKind.HandedOver,
      ]);
      expect(rows[2]).toEqual({
        kind: ExecutionLeaseEventKind.FencedEffect,
        occurredAt: expect.any(String),
        tenantId: "default",
        rootExecutionId: ROOT,
        executionId: ROOT,
        scopeKey: `default:${ROOT}`,
        token: 1,
        holderInstanceId: "instance-1",
        name: "charge",
        outcome: FencedEffectEventOutcome.Refused,
        step: {
          nodeId: "charge-order-action",
          visitNumber: 1,
          idempotencyKey: `${ROOT}:charge-order-action:1`,
        },
        observedToken: 2,
      });
      expect(rows[3]).toMatchObject({
        reason: HandOverReason.Fenced,
        site: HandOverSite.Step,
        holderInstanceId: "instance-1",
        token: 1,
      });
      expect(book.charges.map((charge) => charge.token)).toEqual([2]);
      expect(recovery.errors).toEqual([]);
    },
  );

  two(
    "AC2: a zombie that dies before the write leaves no refusal — the new holder's takeover and write only",
    async ({ apps, clock, leases }) => {
      await zombie(apps, clock, leases, "before");

      const rows = await rootOf(instance(apps, 1), ROOT);

      expect(shapeOf(rows)).toEqual([
        ExecutionLeaseEventKind.Takeover,
        `${ExecutionLeaseEventKind.FencedEffect}:${FencedEffectEventOutcome.Ran}`,
      ]);
      expect(rows[1]).toMatchObject({ holderInstanceId: "instance-2", token: 2, writtenToken: 2 });
      expect(leaseSeen.handOvers).toEqual([]);
    },
  );

  two(
    "AC2: a verifier reading leaseEventsOf alone tells them apart",
    async ({ apps, clock, leases }) => {
      const { call } = await zombie(apps, clock, leases, "before");
      const beforeWaking = verdictOf(await rootOf(instance(apps, 1), ROOT));

      letAllGo();
      await settle();
      leases.resume(instance(apps, 0));
      await rejectionOf(call);
      const afterWaking = verdictOf(await rootOf(instance(apps, 1), ROOT));

      expect(beforeWaking).toBe(ZombieVerdict.NeverAttempted);
      expect(afterWaking).toBe(ZombieVerdict.Refused);
    },
  );

  test("a tree no one took over: NoTakeover, its one Ran row", async ({ app }) => {
    const result = await execute(app, ChargeWorkflowStart, { text: "order-7" });

    const rows = await rootOf(app, result.executionId);

    expect(verdictOf(rows)).toBe(ZombieVerdict.NoTakeover);
    expect(shapeOf(rows)).toEqual([
      `${ExecutionLeaseEventKind.FencedEffect}:${FencedEffectEventOutcome.Ran}`,
    ]);
  });
});

describe("#501 AC3: a replayed fenced effect is told apart from a new write", () => {
  two(
    "AC3: a replayed fenced effect logs Replayed, not Ran — the stored result's token named",
    async ({ apps, clock, leases }) => {
      const { call } = await zombie(apps, clock, leases, "after");

      const rows = await rootOf(instance(apps, 1), ROOT);

      expect(shapeOf(rows)).toEqual([
        `${ExecutionLeaseEventKind.FencedEffect}:${FencedEffectEventOutcome.Ran}`,
        ExecutionLeaseEventKind.Takeover,
        `${ExecutionLeaseEventKind.FencedEffect}:${FencedEffectEventOutcome.Replayed}`,
      ]);
      expect(rows[0]).toMatchObject({ holderInstanceId: "instance-1", token: 1, writtenToken: 1 });
      expect(rows[2]).toMatchObject({ holderInstanceId: "instance-2", token: 2, writtenToken: 1 });
      expect(book.charges).toHaveLength(1);
      letAllGo();
      leases.resume(instance(apps, 0));
      await settle();
      await rejectionOf(call);
    },
  );

  real("two calls on one key in one step: one Ran, one Joined", async ({ app }) => {
    const result = await execute(app, DoubleChargeWorkflowStart, { text: "order-8" });

    const rows = await rootOf(app, result.executionId);

    expect(shapeOf(rows)).toEqual([
      `${ExecutionLeaseEventKind.FencedEffect}:${FencedEffectEventOutcome.Ran}`,
      `${ExecutionLeaseEventKind.FencedEffect}:${FencedEffectEventOutcome.Joined}`,
    ]);
    expect(leaseSeen.fencedEffects.map((event) => event.outcome)).toEqual([
      FencedEffectEventOutcome.Ran,
      FencedEffectEventOutcome.Joined,
    ]);
  });

  test("the row and the event never hold the result", async ({ app }) => {
    const result = await execute(app, ChargeWorkflowStart, { text: "order-7" });

    const rows = await rootOf(app, result.executionId);

    expect(JSON.stringify(rows)).not.toContain("charge-order-7");
    expect(JSON.stringify(leaseSeen.fencedEffects)).not.toContain("charge-order-7");
    expect(leaseSeen.fencedEffects[0]).toMatchObject({
      name: "charge",
      outcome: FencedEffectEventOutcome.Ran,
      step: { nodeId: "charge-order-action" },
      workflow: { name: "charge-workflow" },
    });
  });
});

describe("#501: a write that fails for itself is no outcome", () => {
  test("a result above maxResultSize rolls back: the step's side path takes it, no row", async ({
    app,
  }) => {
    charging.padding = 70_000;

    const result = await execute(app, ChargeWorkflowStart, { text: "order-7" });

    expect(result.finish).toMatchObject({ name: "not-charged-workflow-finish" });
    expect(await rootOf(app, result.executionId)).toEqual([]);
    expect(leaseSeen.fencedEffects).toEqual([]);
  });
});

describe("#501: what never reaches the fenced effect", () => {
  throwing(
    "an observer that throws: a warning; the charge goes on and its row is kept",
    async ({ app }) => {
      const result = await execute(app, ChargeWorkflowStart, { text: "order-7" });

      expect(result.output).toEqual({ chargeId: "charge-order-7-1" });
      expect(await rootOf(app, result.executionId)).toHaveLength(1);
      expect(leaseSeen.fencedEffects).toHaveLength(1);
      expect(logged.map((entry) => entry.code)).toContain("observer.failed");
    },
  );
});
