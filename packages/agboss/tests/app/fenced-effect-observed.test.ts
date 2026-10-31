/**
 * #533 item 3 — what a fenced effect's call tells the lease its step runs under (#501), in a step's
 * frame made by hand: a step's own write is told without a `replayedFrom`, a business key's replay
 * with the step that made it; a write that fails by itself is no outcome — its error rises as it is;
 * a frame with no lease (a reply interpreter's) tells nothing and the write still runs.
 */
import { describe, expect, it } from "vitest";
import type { FencedEffectReport } from "../../src/app/lease-events.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { runInFrame, type FrameLease, type FrameSpec } from "../../src/flow/context/frame.js";
import { FencedEffectEventOutcome } from "../../src/infrastructure/execution-lease-event.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { FencedEffectSettings } from "../../src/infrastructure/fenced-effect-settings.js";
import {
  FencedEffectStatus,
  type FencedEffectKey,
} from "../../src/infrastructure/fenced-effect.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryFencedEffectRepository } from "../../src/infrastructure/in-memory-fenced-effect.repository.js";
import { keyOf } from "../../src/testing/contracts/fenced-effect-data.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { hours } from "../../src/units/index.js";
import { testFrame } from "../helpers/frame.js";

/** The stores of one instance, and a frame under a lease that keeps what it is told. */
function effectsInFrame() {
  const clock = new VirtualClock();
  const database = new InMemoryDatabase();
  const application = applicationContextOf({
    ...{ name: "observed-application", version: "1.0.0", instanceId: "instance-1" },
    ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
  });
  const leases = new InMemoryExecutionLeaseRepository(clock, application, database);
  const effects = new InMemoryFencedEffectRepository(
    clock,
    database,
    new FencedEffectSettings(),
    leases,
  );
  const reports: FencedEffectReport[] = [];
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
    recordFencedEffect: (report) => {
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
  return { effects, reports, held, recording: frameUnder(lease), unleased: frameUnder(undefined) };
}

/** `key` of a business identity, made by step `executionId`. */
const businessKeyOf = (key: FencedEffectKey, executionId: string): FencedEffectKey => ({
  ...key,
  businessKey: "order:42",
  origin: { executionId, nodeId: "charge-action", visitNumber: 1 },
});

describe("#533: a fenced effect's call, told to its lease", () => {
  it("a step's own write: Ran, told with its written token and no replayedFrom", async () => {
    const { effects, reports, held, recording } = effectsInFrame();
    const key = keyOf(await held("execution-1"));

    await runInFrame(recording, () => effects.saveResultIfAbsent(key, () => ({ receipt: "r" })));

    expect(reports.map((report) => report.outcome)).toEqual([FencedEffectEventOutcome.Ran]);
    expect(reports[0]?.writtenToken).toBe(1);
    expect(Object.keys(reports[0] ?? {})).not.toContain("replayedFrom");
  });

  it("a business key's replay: told with the step that made it", async () => {
    const { effects, reports, held, recording } = effectsInFrame();
    const made = businessKeyOf(keyOf(await held("execution-1")), "execution-1");
    const again = businessKeyOf(keyOf(await held("execution-2")), "execution-2");
    await effects.saveResultIfAbsent(made, () => ({ receipt: "r" }));

    const replay = await runInFrame(recording, () =>
      effects.saveResultIfAbsent(again, () => ({ receipt: "again" })),
    );

    expect(replay.status).toBe(FencedEffectStatus.Replayed);
    expect(reports).toMatchObject([
      {
        outcome: FencedEffectEventOutcome.Replayed,
        replayedFrom: { executionId: "execution-1", nodeId: "charge-action", visitNumber: 1 },
      },
    ]);
  });

  it("a write that fails by itself is no outcome: its error rises as it is, nothing told", async () => {
    const { effects, reports, held, recording } = effectsInFrame();
    const key = keyOf(await held("execution-1"));
    const failure = new Error("the business row is invalid");

    const call = runInFrame(recording, () =>
      effects.saveResultIfAbsent(key, () => {
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
      effects.saveResultIfAbsent(key, () => ({ receipt: "r" })),
    );

    expect(outcome.status).toBe(FencedEffectStatus.Ran);
    expect(reports).toEqual([]);
  });
});
