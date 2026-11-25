import { ExecutionError } from "../../src/core/error-families/run-errors.js";
import { OutboundCallError } from "../../src/core/error-families/effect-errors.js";
import { SilentLogger } from "../../src/infrastructure/logger.js";
/**
 * #533 item 3 — the protocol of a call that leaves the system (#505), move by move, in a step's
 * frame made by hand over the in-memory stores: what each move tells the lease (`recordOutboundCall`
 * — the intent's status and attempt), a failed intent sent again with no `NotSent`, a record that
 * another call made at the same moment (in flight, nothing sent), a completed intent with no stored
 * result replayed as `null`, which replay names the step that made it, a frame with no lease, and a
 * send outside any frame.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { OutboundCallReport } from "../../src/app/audit-log.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { runInFrame, type FrameLease, type FrameSpec } from "../../src/flow/context/frame.js";
import {
  ExecutionContextUnavailableError,
  Idempotency,
  InMemoryFencedEffectRepository,
  InMemoryOutboundCallRepository,
  OutboundCallEventOutcome,
  OutboundCallSendStatus,
  OutboundCallStatus,
  OutboundRecovery,
  Reconciliation,
  type IdempotencySendOptions,
  type OutboundCallRecord,
} from "../../src/index.js";
import { OutboundMasking } from "../../src/app/outbound-masking.js";
import { type EffectKey } from "../../src/stores/index.js";
import { type OutboundCallIntent } from "../../src/stores/index.js";
import {
  InMemoryExecutionLeaseRepository,
  type ExecutionLease,
} from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { keyOf } from "../../src/testing/contracts/fenced-effect-data.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { hours, seconds } from "../../src/units/index.js";
import { testFrame } from "../helpers/frame.js";
import { TEST_IDEMPOTENCY_KEY } from "../../src/application/idempotency-key.js";
import { storeClockOf } from "../helpers/store-clock.js";

/** How the store under the protocol misbehaves, when it does. */
const storeScript = { isRecordedElsewhere: false, isResultDropped: false };

beforeEach(() => {
  storeScript.isRecordedElsewhere = false;
  storeScript.isResultDropped = false;
});

/** The in-memory store; scripted, it says another call recorded the key, or drops a result. */
class ScriptedOutboundCallRepository extends InMemoryOutboundCallRepository {
  override async saveIfAbsent(key: EffectKey, intent: OutboundCallIntent) {
    return storeScript.isRecordedElsewhere ? false : super.saveIfAbsent(key, intent);
  }

  override async findByKey(key: EffectKey): Promise<OutboundCallRecord | undefined> {
    const found = await super.findByKey(key);
    if (found === undefined || !storeScript.isResultDropped) return found;
    const dropped = { ...found };
    delete dropped.result;
    return dropped;
  }
}

const TEST_KEYS = { current: TEST_IDEMPOTENCY_KEY };

/** The stores of one instance, and a step's frame under a lease that keeps what it is told. */
function callsInFrame() {
  const clock = new VirtualClock();
  const database = new InMemoryDatabase();
  const application = applicationContextOf({
    ...{ name: "outbound-application", version: "1.0.0", instanceId: "instance-1" },
    ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
  });
  const leases = new InMemoryExecutionLeaseRepository(storeClockOf(clock), application, database);
  const store = new ScriptedOutboundCallRepository(storeClockOf(clock), database, leases);
  const effects = new InMemoryFencedEffectRepository(storeClockOf(clock), database, leases);
  const reports: OutboundCallReport[] = [];
  const idempotency = new Idempotency(
    effects,
    store,
    new OutboundMasking({ requiresMask: false }),
    new SilentLogger(),
    clock,
  );
  const base = testFrame();
  /** The step's frame under `taken` (none: a frame with no lease), `extra` over the lease (a hook of the holder). */
  const frameUnder = (
    taken: ExecutionLease | undefined,
    extra: Partial<FrameLease> = {},
    step: Partial<typeof base.step> & { readonly executionId?: string } = {},
  ): FrameSpec => {
    const { executionId = taken?.rootExecutionId ?? base.execution.executionId, ...stepFields } =
      step;
    const lease: FrameLease | undefined =
      taken === undefined
        ? undefined
        : {
            tenantId: taken.tenantId,
            leaseExecutionId: taken.rootExecutionId,
            scopeKey: keyOf(taken).scopeKey,
            token: taken.token,
            trustedUntil: Number.POSITIVE_INFINITY,
            isYielded: false,
            assertHeld: () => undefined,
            renewNow: () => Promise.resolve(),
            enterStep: () => Promise.resolve(() => undefined),
            recordOutboundCall: (report) => {
              reports.push(report);
            },
            ...extra,
          };
    return {
      ...base,
      // an application's frame carries its idempotency keys (#825): a business key's fingerprint
      execution: { ...base.execution, executionId, lease, fingerprintKeys: TEST_KEYS },
      step: { ...base.step, ...stepFields },
    };
  };
  const take = async (executionId: string): Promise<ExecutionLease> => {
    const taken = await leases.acquire("default", executionId, hours(1));
    if (taken === undefined) throw new Error("the lease is held");
    return taken;
  };
  /** The frame of the step of `executionId`'s lease, taken now. */
  const frameIn = async (
    executionId: string,
    extra: Partial<FrameLease> = {},
    step: Parameters<typeof frameUnder>[2] = {},
  ) => frameUnder(await take(executionId), extra, step);
  /** `sendOnce` of the charge in `frame`, under `key` when one is given. */
  const send = <TRequest, TResult>(
    frame: FrameSpec,
    options: Omit<IdempotencySendOptions<TRequest, TResult>, "name" | "key" | "timeout" | "ttl">,
    key?: string,
  ) =>
    runInFrame(frame, () =>
      idempotency.sendOnce({
        name: "charge",
        ...(key === undefined ? {} : { key }),
        timeout: seconds(15),
        ttl: hours(48),
        ...options,
      }),
    );
  return { idempotency, send, leases, reports, frameIn, frameUnder, take };
}

/**
 * The provider: answers each charge, or fails the next one — a decline (definite, #657) or a
 * gateway timeout (of unknown outcome); counts what reached it.
 */
function provider() {
  const sent: number[] = [];
  const state = { failNext: false, timesOut: false };
  const options = {
    target: "payments",
    operation: "charge",
    request: { orderId: "order-7", amountUsd: 10 },
    send: (call: { readonly attempt: number }) => {
      sent.push(call.attempt);
      if (!state.failNext) return { chargeId: `ch-${String(call.attempt)}` };
      state.failNext = false;
      throw new Error(state.timesOut ? "gateway timeout" : "declined");
    },
    recovery: OutboundRecovery.permanentLookup<{ chargeId: string }>(() =>
      Reconciliation.notExecuted(),
    ),
    isDefiniteFailure: (error: unknown) => error instanceof Error && error.message === "declined",
  };
  return { sent, state, options };
}

/** What each told move says: its outcome, the intent's status and attempt. */
const movesOf = (reports: readonly OutboundCallReport[]) =>
  reports.map((report) => [report.outcome, report.status, report.attempt]);

describe("#533: the moves of a call, told to its lease", () => {
  it("a provider error: Recorded (pending, 1), then Failed (failed, 1)", async () => {
    const { send, reports, frameIn } = callsInFrame();
    const { state, options } = provider();
    const frame = await frameIn("execution-1");
    state.failNext = true;

    await expect(send(frame, options)).rejects.toThrow("declined");

    expect(movesOf(reports)).toEqual([
      [OutboundCallEventOutcome.Recorded, OutboundCallStatus.Pending, 1],
      [OutboundCallEventOutcome.Failed, OutboundCallStatus.Failed, 1],
    ]);
  });

  it("a failed intent is sent again at the next attempt with no NotSent move", async () => {
    const { send, reports, frameIn } = callsInFrame();
    const { sent, state, options } = provider();
    const frame = await frameIn("execution-1");
    state.failNext = true;
    await send(frame, options).catch(() => undefined);
    reports.length = 0;

    const again = await send(frame, options);

    expect(again).toMatchObject({ status: OutboundCallSendStatus.Sent, attempt: 2 });
    expect(movesOf(reports)).toEqual([
      [OutboundCallEventOutcome.Sent, OutboundCallStatus.Completed, 2],
    ]);
    expect(sent).toEqual([1, 2]);
  });

  it("#657: an error of unknown outcome: Recorded, then Ambiguous (pending, 1) — the next call reconciles, NotSent then Sent", async () => {
    const { send, reports, frameIn } = callsInFrame();
    const { sent, state, options } = provider();
    const frame = await frameIn("execution-1");
    state.failNext = true;
    state.timesOut = true;

    await expect(send(frame, options)).rejects.toThrow("gateway timeout");
    const again = await send(frame, options);

    expect(again).toMatchObject({ status: OutboundCallSendStatus.Sent, attempt: 2 });
    expect(movesOf(reports)).toEqual([
      [OutboundCallEventOutcome.Recorded, OutboundCallStatus.Pending, 1],
      [OutboundCallEventOutcome.Ambiguous, OutboundCallStatus.Pending, 1],
      [OutboundCallEventOutcome.NotSent, OutboundCallStatus.Pending, 2],
      [OutboundCallEventOutcome.Sent, OutboundCallStatus.Completed, 2],
    ]);
    expect(sent).toEqual([1, 2]);
  });

  it("an intent another call recorded at the same moment: in flight, naming the call, nothing sent", async () => {
    const { send, frameIn } = callsInFrame();
    const { sent, options } = provider();
    const frame = await frameIn("execution-1");
    storeScript.isRecordedElsewhere = true;

    const refused = send(frame, options);

    await expect(refused).rejects.toBeInstanceOf(OutboundCallError.InFlight);
    await expect(refused).rejects.toMatchObject({
      call: "charge",
      target: "payments",
      operation: "charge",
    });
    expect(sent).toEqual([]);
  });

  it("a completed intent whose result the store does not give back is replayed as null", async () => {
    const { send, frameIn } = callsInFrame();
    const { options } = provider();
    const frame = await frameIn("execution-1");
    await send(frame, options);
    storeScript.isResultDropped = true;

    const replay = await send(frame, options);

    expect(replay).toMatchObject({ status: OutboundCallSendStatus.Replayed, result: null });
  });
});

describe("#533: which replay names the step that made the call", () => {
  it("a step's own replay names none: neither the outcome nor the told move has replayedFrom", async () => {
    const { send, reports, frameIn } = callsInFrame();
    const { options } = provider();
    const frame = await frameIn("execution-1");
    await send(frame, options);
    reports.length = 0;

    const replay = await send(frame, options);

    expect(replay.status).toBe(OutboundCallSendStatus.Replayed);
    expect(Object.keys(replay)).not.toContain("replayedFrom");
    expect(Object.keys(reports[0] ?? {})).not.toContain("replayedFrom");
  });

  it("a business key's replay from another step names the step that made it, in the outcome and the move", async () => {
    const { send, reports, frameIn } = callsInFrame();
    const { options } = provider();
    const first = await frameIn("execution-1");
    const made = {
      executionId: first.execution.executionId,
      nodeId: first.step.nodeId,
      visitNumber: first.step.visitNumber,
    };
    await send(first, options, "order:42");
    reports.length = 0;
    const elsewhere = { executionId: "execution-2", nodeId: "charge-action", visitNumber: 1 };
    const again = await frameIn("execution-2", {}, elsewhere);

    const replay = await send(again, options, "order:42");

    expect(replay).toMatchObject({
      status: OutboundCallSendStatus.Replayed,
      replayedFrom: made,
    });
    expect(reports).toMatchObject([
      { outcome: OutboundCallEventOutcome.Replayed, replayedFrom: made },
    ]);
  });
});

describe("#533: where a call is sent from", () => {
  it("a frame with no lease of its own: no fence to write under — ExecutionContextUnavailableError, nothing sent", async () => {
    const { send, frameUnder } = callsInFrame();
    const { sent, options } = provider();

    const refused = send(frameUnder(undefined), options);

    await expect(refused).rejects.toBeInstanceOf(ExecutionContextUnavailableError);
    expect(sent).toEqual([]);
  });

  it("outside any frame: ExecutionContextUnavailableError naming Idempotency", async () => {
    const { idempotency } = callsInFrame();
    const { sent, options } = provider();

    const refused = idempotency.sendOnce({
      name: "charge",
      timeout: seconds(15),
      ttl: hours(48),
      ...options,
    });

    await expect(refused).rejects.toBeInstanceOf(ExecutionContextUnavailableError);
    await expect(refused).rejects.toThrow(/^Idempotency read /u);
    expect(sent).toEqual([]);
  });
});

describe("#909: a call whose tree was cancelled", () => {
  const cancelled = async (leases: InMemoryExecutionLeaseRepository) =>
    leases.requestCancel({ tenantId: "default", rootExecutionId: "execution-1" });

  it("is refused before an intent: told Cancelled (pending, 0), the holder stops the tree, nothing sent", async () => {
    const { send, leases, reports, frameIn } = callsInFrame();
    const { sent, options } = provider();
    const found: unknown[] = [];
    const frame = await frameIn("execution-1", { cancelFound: (error) => found.push(error) });
    await cancelled(leases);

    const refusal = await send(frame, options).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ExecutionError.CancelFenced);
    expect(found).toEqual([refusal]);
    expect(movesOf(reports)).toEqual([
      [OutboundCallEventOutcome.Cancelled, OutboundCallStatus.Pending, 0],
    ]);
    expect(sent).toEqual([]);
  });

  it("a lease with no way to stop the tree: the refusal is the call's error", async () => {
    const { send, leases, reports, frameIn } = callsInFrame();
    const { options } = provider();
    const frame = await frameIn("execution-1");
    await cancelled(leases);

    await expect(send(frame, options)).rejects.toBeInstanceOf(ExecutionError.CancelFenced);
    expect(movesOf(reports)).toEqual([
      [OutboundCallEventOutcome.Cancelled, OutboundCallStatus.Pending, 0],
    ]);
  });

  it("another error is no cancel: not told Cancelled, the holder is not asked to stop", async () => {
    const { send, reports, frameIn } = callsInFrame();
    const { state, options } = provider();
    const found: unknown[] = [];
    const frame = await frameIn("execution-1", { cancelFound: (error) => found.push(error) });
    state.failNext = true;

    await expect(send(frame, options)).rejects.toThrow("declined");

    expect(found).toEqual([]);
    expect(reports.map((report) => report.outcome)).not.toContain(
      OutboundCallEventOutcome.Cancelled,
    );
  });
});
