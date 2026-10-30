/**
 * #505 — a new attempt is a compare-and-set: two callers that read one intent move it once, and only
 * the winner sends. The loser reads the intent again and follows the protocol — the winner's
 * result replayed, its pending attempt in flight (`OutboundCallInFlightError`), nothing sent — at
 * most three reads. The rival is a real second caller interleaved at the store: between this
 * call's read and its move, it moves the same intent through the same store.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ExecutionLeaseRepository,
  Injectable,
  InMemoryOutboundCallRepository,
  OutboundCallInFlightError,
  OutboundCallRepository,
  OutboundCallStatus,
  type FencedEffectKey,
  type OutboundCallRecord,
} from "../../src/index.js";
import { Clock } from "../../src/infrastructure/clock.js";
import { stateOf } from "../../src/app/outbound-call-business.js";
import { IN_MEMORY_DATABASE } from "../../src/infrastructure/in-memory-database.js";
import { override, testAction } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { ChargeOrderAction, resetRuns, runs } from "./fixtures/outbound-call.workflow.js";
import { gateway, letChargesGo, resetGateway } from "./fixtures/payment-gateway.js";

const order = { message: { value: { text: "order-1" } } } as never;

/** What the rival does between this call's read and its move, and how many reads it acts on. */
enum RivalMove {
  /** Moves the intent to the next attempt: it is sending now. */
  Resends = "resends",
  /** Sends and completes it. */
  Completes = "completes",
  /** Moves it and fails it again, every read: the call never gets to move it. */
  KeepsFailing = "keeps-failing",
}

const rival = { move: RivalMove.Resends, reads: 0, moves: 0 };

@Injectable({ deps: [Clock, IN_MEMORY_DATABASE, ExecutionLeaseRepository] })
class RacedOutboundCallRepository extends InMemoryOutboundCallRepository {
  override async findByKey(key: FencedEffectKey): Promise<OutboundCallRecord | undefined> {
    const found = await super.findByKey(key);
    if (found === undefined || found.status === OutboundCallStatus.Completed || rival.reads <= 0)
      return found;
    rival.reads -= 1;
    await this.#moved(key, found);
    return found; // this call goes on from what it read: the rival's move is unseen
  }

  async #moved(key: FencedEffectKey, found: OutboundCallRecord): Promise<void> {
    const claim = { attempt: found.attempt + 1, attemptOwner: "rival" };
    if (!(await super.markPending(key, stateOf(found), claim))) return;
    rival.moves += 1;
    if (rival.move === RivalMove.Completes)
      await this.markCompleted(key, '{"chargeId":"ch-rival"}');
    if (rival.move === RivalMove.KeepsFailing)
      await this.markFailed(key, { name: "Error", code: "Error", message: "declined again" });
  }
}

const raced = () =>
  testAction(ChargeOrderAction, {
    overrides: [override(OutboundCallRepository, RacedOutboundCallRepository)],
  });

/** A runner whose first run failed at the provider: its intent `Failed`, attempt 1. */
async function failedOnce() {
  const run = raced();
  gateway.failNext = 1;
  await expect(run(order)).rejects.toThrow("card declined");
  return run;
}

beforeEach(() => {
  resetGateway();
  resetRuns();
  Object.assign(rival, { move: RivalMove.Resends, reads: 0, moves: 0 });
});

afterEach(letChargesGo);

describe("#505: a new attempt is a compare-and-set", () => {
  it("a rival moved the failed intent first: this call sends nothing — in flight", async () => {
    const run = await failedOnce();
    Object.assign(rival, { move: RivalMove.Resends, reads: 1 });

    await expect(run(order)).rejects.toBeInstanceOf(OutboundCallInFlightError);
    expect(gateway.calls).toHaveLength(1); // the first attempt only: the rival's send is its own
    expect(rival.moves).toBe(1);
  });

  it("a rival sent and completed it first: this call replays the rival's result, nothing sent", async () => {
    const run = await failedOnce();
    Object.assign(rival, { move: RivalMove.Completes, reads: 1 });

    const replayed = await run(order);

    expect(replayed.output).toEqual({ chargeId: "ch-rival" });
    expect(runs.outcomes).toEqual([{ status: "replayed", attempt: 2 }]);
    expect(gateway.calls).toHaveLength(1);
  });

  it("a rival that moves it first on every read: three reads, then in flight, nothing sent", async () => {
    const run = await failedOnce();
    Object.assign(rival, { move: RivalMove.KeepsFailing, reads: 10 });

    await expect(run(order)).rejects.toBeInstanceOf(OutboundCallInFlightError);
    expect(rival.moves).toBe(3);
    expect(gateway.calls).toHaveLength(1);
  });

  it("a rival moved a pending intent after reconcile said notSent: this call sends nothing", async () => {
    const run = raced();
    gateway.gates.before = 1;
    const first = run(order, { timeout: seconds(1) });
    first.catch(() => undefined);
    await run.clock.advance(seconds(1));
    await expect(first).rejects.toThrow();
    Object.assign(rival, { move: RivalMove.Resends, reads: 1 });

    await expect(run(order)).rejects.toBeInstanceOf(OutboundCallInFlightError);
    expect(gateway.lookups).toHaveLength(1);
    expect(gateway.calls).toHaveLength(1);
  });

  it("no rival: the failed intent is moved once and sent again (attempt 2)", async () => {
    const run = await failedOnce();

    const sent = await run(order);

    expect(sent.output).toEqual({ chargeId: "ch-order-1-1" });
    expect(gateway.calls.map((call) => call.attempt)).toEqual([1, 2]);
  });
});
