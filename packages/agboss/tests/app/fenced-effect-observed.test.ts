/**
 * #533 item 3 — what a fenced effect's call tells the lease its step runs under (#501), in a step's
 * frame made by hand: a step's own write is told without a `replayedFrom`, a business key's replay
 * with the step that made it; a write that fails by itself is no outcome — its error rises as it is;
 * a frame with no lease (a reply interpreter's) tells nothing and the write still runs.
 */
import { ExecutionError } from "../../src/core/error-families/run-errors.js";
import { effectKeyForTesting } from "../../src/testing/contracts/effect-key.js";
import { describe, expect, it } from "vitest";
import type { IdempotencyRunReport } from "../../src/app/audit-log.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { runInFrame, type FrameLease, type FrameSpec } from "../../src/flow/context/frame.js";
import { IdempotencyRunEventOutcome } from "../../src/infrastructure/execution-audit-log.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import {
  IdempotencyRunStatus,
  type EffectKey,
} from "../../src/infrastructure/fenced-effect.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryFencedEffectRepository } from "../../src/infrastructure/in-memory-fenced-effect.repository.js";
import { keyOf } from "../../src/testing/contracts/fenced-effect-data.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { hours } from "../../src/units/index.js";
import { testFrame } from "../helpers/frame.js";
import { storeClockOf } from "../helpers/store-clock.js";

/** The stores of one instance, and a frame under a lease that keeps what it is told. */
function effectsInFrame() {
  const clock = new VirtualClock();
  const database = new InMemoryDatabase();
  const application = applicationContextOf({
    ...{ name: "observed-application", version: "1.0.0", instanceId: "instance-1" },
    ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
  });
  const leases = new InMemoryExecutionLeaseRepository(storeClockOf(clock), application, database);
  const effects = new InMemoryFencedEffectRepository(storeClockOf(clock), database, leases);
  const reports: IdempotencyRunReport[] = [];
  const lease: FrameLease = {
    tenantId: "default",
    leaseExecutionId: "execution-1",
    scopeKey: "default:execution-1",
    token: 1,
    trustedUntil: Number.POSITIVE_INFINITY,
    isYielded: false,
    assertHeld: () => undefined,
    renewNow: () => Promise.resolve(),
    enterStep: () => Promise.resolve(() => undefined),
    recordIdempotencyRun: (report) => {
      reports.push(report);
    },
  };
  const frameUnder = (frameLease: FrameLease | undefined): FrameSpec => {
    const frame = testFrame();
    return { ...frame, execution: { ...frame.execution, lease: frameLease } };
  };
  const held = async (executionId: string) => {
    const taken = await leases.acquire("default", executionId, hours(1));
    if (taken === undefined) throw new Error("the lease is held");
    return taken;
  };
  return {
    ...{ effects, leases, reports, held },
    recording: frameUnder(lease),
    unleased: frameUnder(undefined),
    recordingWith: (extra: Partial<FrameLease>) => frameUnder({ ...lease, ...extra }),
  };
}

/** `key` of a business identity, made by step `executionId`. */
const businessKeyOf = (key: EffectKey, executionId: string): EffectKey =>
  effectKeyForTesting(key, {
    businessKey: "order:42",
    fingerprint: "a receipt for order 42",
    origin: { executionId, nodeId: "charge-action", visitNumber: 1 },
  });

describe("#533: a fenced effect's call, told to its lease", () => {
  it("a step's own write: Ran, told with its written token and no replayedFrom", async () => {
    const { effects, reports, held, recording } = effectsInFrame();
    const key = keyOf(await held("execution-1"));

    await runInFrame(recording, () => effects.runOnce(key, () => ({ receipt: "r" })));

    expect(reports.map((report) => report.outcome)).toEqual([IdempotencyRunEventOutcome.Ran]);
    expect(reports[0]?.writtenToken).toBe(1);
    expect(Object.keys(reports[0] ?? {})).not.toContain("replayedFrom");
  });

  it("a business key's replay: told with the step that made it", async () => {
    const { effects, reports, held, recording } = effectsInFrame();
    const made = businessKeyOf(keyOf(await held("execution-1")), "execution-1");
    const again = businessKeyOf(keyOf(await held("execution-2")), "execution-2");
    await effects.runOnce(made, () => ({ receipt: "r" }));

    const replay = await runInFrame(recording, () =>
      effects.runOnce(again, () => ({ receipt: "again" })),
    );

    expect(replay.status).toBe(IdempotencyRunStatus.Replayed);
    expect(reports).toMatchObject([
      {
        outcome: IdempotencyRunEventOutcome.Replayed,
        replayedFrom: { executionId: "execution-1", nodeId: "charge-action", visitNumber: 1 },
      },
    ]);
  });

  it("a write that fails by itself is no outcome: its error rises as it is, nothing told", async () => {
    const { effects, reports, held, recording } = effectsInFrame();
    const key = keyOf(await held("execution-1"));
    const failure = new Error("the business row is invalid");

    const call = runInFrame(recording, () =>
      effects.runOnce(key, () => {
        throw failure;
      }),
    );

    await expect(call).rejects.toBe(failure);
    expect(reports).toEqual([]);
  });

  it("in a frame with no lease: the write runs, nothing is told", async () => {
    const { effects, reports, held, unleased } = effectsInFrame();
    const key = keyOf(await held("execution-1"));

    const outcome = await runInFrame(unleased, () =>
      effects.runOnce(key, () => ({ receipt: "r" })),
    );

    expect(outcome.status).toBe(IdempotencyRunStatus.Ran);
    expect(reports).toEqual([]);
  });
});

describe("#909: a write of a tree that was cancelled", () => {
  it("is told Cancelled (no token facts) and the holder is asked to stop the tree; the refusal is the call's error", async () => {
    const { effects, leases, reports, held, recordingWith } = effectsInFrame();
    const key = keyOf(await held("execution-1"));
    await leases.requestCancel({ tenantId: "default", rootExecutionId: "execution-1" });
    const found: unknown[] = [];
    let ran = false;

    const refusal = await runInFrame(
      recordingWith({ cancelFound: (error) => found.push(error) }),
      () =>
        effects.runOnce(key, () => {
          ran = true;
          return { receipt: "r" };
        }),
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ExecutionError.CancelFenced);
    expect(found).toEqual([refusal]);
    expect(ran).toBe(false);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      outcome: IdempotencyRunEventOutcome.Cancelled,
      name: key.name,
    });
    expect(Object.keys(reports[0] ?? {})).not.toContain("observedToken");
  });
});
