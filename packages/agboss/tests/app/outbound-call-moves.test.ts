/**
 * #533 item 3 — the protocol of a call that leaves the system (#505), move by move, in a step's
 * frame made by hand over the in-memory stores: what each move tells the lease (`recordOutboundCall`
 * — the intent's status and attempt), a failed intent sent again with no `NotSent`, a record that
 * another call made at the same moment (in flight, nothing sent), a completed intent with no stored
 * result replayed as `null`, which replay names the step that made it, a frame with no lease, and a
 * send outside any frame.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { OutboundCallReport } from "../../src/app/lease-events.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { runInFrame, type FrameLease, type FrameSpec } from "../../src/flow/context/frame.js";
import {
  ExecutionContextUnavailableError,
  InMemoryOutboundCallRepository,
  OutboundCallEventOutcome,
  OutboundCallInFlightError,
  OutboundCallOutcomeStatus,
  OutboundCallReconciliation,
  OutboundCalls,
  OutboundCallSettings,
  OutboundCallStatus,
  type FencedEffectKey,
  type OutboundCallIntent,
  type OutboundCallRecord,
} from "../../src/index.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { keyOf } from "../../src/testing/contracts/fenced-effect-data.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { hours } from "../../src/units/index.js";
import { testFrame } from "../helpers/frame.js";

/** How the store under the protocol misbehaves, when it does. */
const storeScript = { isRecordedElsewhere: false, isResultDropped: false };

beforeEach(() => {
  storeScript.isRecordedElsewhere = false;
  storeScript.isResultDropped = false;
});

/** The in-memory store; scripted, it says another call recorded the key, or drops a result. */
class ScriptedOutboundCallRepository extends InMemoryOutboundCallRepository {
  override async saveIfAbsent(key: FencedEffectKey, intent: OutboundCallIntent) {
    return storeScript.isRecordedElsewhere ? false : super.saveIfAbsent(key, intent);
  }

  override async findByKey(key: FencedEffectKey): Promise<OutboundCallRecord | undefined> {
    const found = await super.findByKey(key);
    if (found === undefined || !storeScript.isResultDropped) return found;
    const dropped = { ...found };
    delete dropped.result;
    return dropped;
  }
}

/** The stores of one instance, a step's frame under a lease that keeps what it is told. */
function callsInFrame() {
  const clock = new VirtualClock();
  const database = new InMemoryDatabase();
  const application = applicationContextOf({
    ...{ name: "outbound-application", version: "1.0.0", instanceId: "instance-1" },
    ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
  });
  const leases = new InMemoryExecutionLeaseRepository(clock, application, database);
  const store = new ScriptedOutboundCallRepository(clock, database, leases);
  const reports: OutboundCallReport[] = [];
  const lease: FrameLease = {
    tenantId: "default",
    leaseExecutionId: "execution-1",
    scopeKey: "default:execution-1",
    token: 1,
    confirmedUntil: Number.POSITIVE_INFINITY,
    isYielded: false,
    assertHeld: () => undefined,
    confirmNow: () => Promise.resolve(),
    enterStep: () => Promise.resolve(() => undefined),
    recordOutboundCall: (report) => {
      reports.push(report);
    },
  };
  const base = testFrame();
  const frameUnder = (frameLease: FrameLease | undefined): FrameSpec => ({
    ...base,
    execution: { ...base.execution, lease: frameLease },
  });
  const origin = {
    executionId: base.execution.executionId,
    nodeId: base.step.nodeId,
    visitNumber: base.step.visitNumber,
  };
  const keyIn = async (executionId: string): Promise<FencedEffectKey> => {
    const taken = await leases.acquire("default", executionId, hours(1));
    if (taken === undefined) throw new Error("the lease is held");
    return { ...keyOf(taken), origin };
  };
  return {
    calls: new OutboundCalls(store, new OutboundCallSettings()),
    reports,
    keyIn,
    recording: frameUnder(lease),
    unleased: frameUnder(undefined),
  };
}

/** The provider: answers each charge, or fails the next one; counts what reached it. */
function provider() {
  const sent: number[] = [];
  const state = { failNext: false };
  const options = {
    target: "payments",
    operation: "charge",
    request: { orderId: "order-7", amountUsd: 10 },
    send: (call: { readonly attempt: number }) => {
      sent.push(call.attempt);
      if (!state.failNext) return { chargeId: `ch-${String(call.attempt)}` };
      state.failNext = false;
      throw new Error("declined");
    },
    reconcile: () => OutboundCallReconciliation.notSent(),
  };
  return { sent, state, options };
}

/** What each told move says: its outcome, the intent's status and attempt. */
const movesOf = (reports: readonly OutboundCallReport[]) =>
  reports.map((report) => [report.outcome, report.status, report.attempt]);

describe("#533: the moves of a call, told to its lease", () => {
  it("a provider error: Recorded (pending, 1), then Failed (failed, 1)", async () => {
    const { calls, reports, keyIn, recording } = callsInFrame();
    const { state, options } = provider();
    const key = await keyIn("execution-1");
    state.failNext = true;

    await expect(runInFrame(recording, () => calls.send(key, options))).rejects.toThrow("declined");

    expect(movesOf(reports)).toEqual([
      [OutboundCallEventOutcome.Recorded, OutboundCallStatus.Pending, 1],
      [OutboundCallEventOutcome.Failed, OutboundCallStatus.Failed, 1],
    ]);
  });

  it("a failed intent is sent again at the next attempt with no NotSent move", async () => {
    const { calls, reports, keyIn, recording } = callsInFrame();
    const { sent, state, options } = provider();
    const key = await keyIn("execution-1");
    state.failNext = true;
    await runInFrame(recording, () => calls.send(key, options)).catch(() => undefined);
    reports.length = 0;

    const again = await runInFrame(recording, () => calls.send(key, options));

    expect(again).toMatchObject({ status: OutboundCallOutcomeStatus.Sent, attempt: 2 });
    expect(movesOf(reports)).toEqual([
      [OutboundCallEventOutcome.Sent, OutboundCallStatus.Completed, 2],
    ]);
    expect(sent).toEqual([1, 2]);
  });

  it("an intent another call recorded at the same moment: in flight, naming the call, nothing sent", async () => {
    const { calls, keyIn, recording } = callsInFrame();
    const { sent, options } = provider();
    const key = await keyIn("execution-1");
    storeScript.isRecordedElsewhere = true;

    const refused = runInFrame(recording, () => calls.send(key, options));

    await expect(refused).rejects.toBeInstanceOf(OutboundCallInFlightError);
    await expect(refused).rejects.toMatchObject({
      call: "charge",
      target: "payments",
      operation: "charge",
    });
    expect(sent).toEqual([]);
  });

  it("a completed intent whose result the store does not give back is replayed as null", async () => {
    const { calls, keyIn, recording } = callsInFrame();
    const { options } = provider();
    const key = await keyIn("execution-1");
    await runInFrame(recording, () => calls.send(key, options));
    storeScript.isResultDropped = true;

    const replay = await runInFrame(recording, () => calls.send(key, options));

    expect(replay).toMatchObject({ status: OutboundCallOutcomeStatus.Replayed, result: null });
  });
});

describe("#533: which replay names the step that made the call", () => {
  it("a step's own replay names none: neither the outcome nor the told move has replayedFrom", async () => {
    const { calls, reports, keyIn, recording } = callsInFrame();
    const { options } = provider();
    const key = await keyIn("execution-1");
    await runInFrame(recording, () => calls.send(key, options));
    reports.length = 0;

    const replay = await runInFrame(recording, () => calls.send(key, options));

    expect(replay.status).toBe(OutboundCallOutcomeStatus.Replayed);
    expect(Object.keys(replay)).not.toContain("replayedFrom");
    expect(Object.keys(reports[0] ?? {})).not.toContain("replayedFrom");
  });

  it("a business key's replay from another step names the step that made it, in the outcome and the move", async () => {
    const { calls, reports, keyIn, recording } = callsInFrame();
    const { options } = provider();
    const made = { ...(await keyIn("execution-1")), businessKey: "order:42" };
    await runInFrame(recording, () => calls.send(made, options));
    reports.length = 0;
    const elsewhere = { executionId: "execution-2", nodeId: "charge-action", visitNumber: 1 };
    const again = { ...(await keyIn("execution-2")), businessKey: "order:42", origin: elsewhere };

    const replay = await runInFrame(recording, () => calls.send(again, options));

    expect(replay).toMatchObject({
      status: OutboundCallOutcomeStatus.Replayed,
      replayedFrom: made.origin,
    });
    expect(reports).toMatchObject([
      { outcome: OutboundCallEventOutcome.Replayed, replayedFrom: made.origin },
    ]);
  });
});

describe("#533: where a call is sent from", () => {
  it("a frame with no lease of its own: the stores' fence alone guards it, and it is sent", async () => {
    const { calls, keyIn, unleased } = callsInFrame();
    const { sent, options } = provider();
    const key = await keyIn("execution-1");

    const outcome = await runInFrame(unleased, () => calls.send(key, options));

    expect(outcome.status).toBe(OutboundCallOutcomeStatus.Sent);
    expect(sent).toEqual([1]);
  });

  it("outside any frame: ExecutionContextUnavailableError naming OutboundCalls.send", async () => {
    const { calls, keyIn } = callsInFrame();
    const { sent, options } = provider();

    const refused = calls.send(await keyIn("execution-1"), options);

    await expect(refused).rejects.toBeInstanceOf(ExecutionContextUnavailableError);
    await expect(refused).rejects.toThrow(/^OutboundCalls read send outside an execution\./u);
    expect(sent).toEqual([]);
  });
});
