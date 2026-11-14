/**
 * #928 AC1 lease scopes — `LeasedCheckpointSaver`: a put is lease-held work (a hand-over when it
 * never answers), the renewal it makes first is the lease store's own and never one.
 */
import { MemorySaver, emptyCheckpoint } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ExecutionAuditEventKind,
  ExecutionLeaseLostError,
  StoreCallTimeoutError,
} from "../../src/index.js";
import { executionLeasesOf } from "../../src/app/execution-leases.js";
import { LeasedCheckpointSaver } from "../../src/app/leased-checkpointer.js";
import { boundedStoreOf } from "../../src/app/store-call-bound.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { BaseCheckpointSaver } from "@langchain/langgraph";
import { testWith } from "../../src/testing/index.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { processHoldPoints } from "../../src/testing/faults/hold-points.js";
import { seconds } from "../../src/units/index.js";
import { logged } from "../helpers/log.js";
import { execute } from "../helpers/flow.js";
import { until } from "../helpers/until.js";
import { passLive } from "../helpers/live-time.js";
import { storeClockOf } from "../helpers/store-clock.js";
import { rejectionOf } from "./fixtures/fence-takeover.js";
import { ChargeWorkflowStart, book } from "./fixtures/fenced-effect.workflow.js";
import { LeaseScopeAuditApplication } from "./fixtures/lease-scope-audit.application.js";
import { hangNext, holdRenewAfterPut, hung } from "./fixtures/lease-scope-bound.application.js";
import {
  ready,
  releaseHolds,
  resetScopeBound,
  trackOf,
} from "./fixtures/lease-scope-bound.helpers.js";

const pair = testWith(LeaseScopeAuditApplication, { instances: 2 });

beforeEach(resetScopeBound);
afterEach(releaseHolds);

describe("#928 AC1 lease scopes: LeasedCheckpointSaver", () => {
  const name =
    "a checkpoint put held for ever under LeasedCheckpointSaver hands over; recovery resumes from the last checkpoint; its renewal is unleased";
  // the third put stores the charge's step; the first is made before any step runs
  const cases = [
    { which: "the first put", skip: 0, charged: 0 },
    { which: "a put after the charge", skip: 3, charged: 1 },
  ] as const;

  for (const { which, skip, charged } of cases) {
    pair(`${name} (${which})`, async ({ apps, clock }) => {
      const [a] = await ready(apps);
      hangNext("checkpoint.put", 1, skip);
      const failure = rejectionOf(execute(a, ChargeWorkflowStart, { text: "order-4" }));
      await until(() => hung.left.get("checkpoint.put") === 0, "a checkpoint put is held");
      expect(book.charges).toHaveLength(charged);

      await passLive(clock, seconds(40));
      const error = await failure;

      expect(error).toBeInstanceOf(ExecutionLeaseLostError);
      expect((error as ExecutionLeaseLostError).cause).toBeInstanceOf(StoreCallTimeoutError);
      expect(logged.map((entry) => entry.code)).toContain("execution.lease-abandoned");
      await passLive(clock, seconds(60));
      await passLive(clock, seconds(60));

      const rows = await a.auditLogOf({ tenantId: "default", rootExecutionId: "execution-1" });
      const takeover = rows.find((row) => row.kind === ExecutionAuditEventKind.Takeover);
      expect(takeover).toMatchObject({ reason: "recovered", token: 2 });
      // continued from the last checkpoint: the charge made is never made again
      expect(book.charges.length).toBeLessThanOrEqual(1);
      expect(logged.map((entry) => entry.code)).toContain("execution.recovered");
    });
  }

  pair(`${name} (its renewal)`, async ({ apps, clock }) => {
    const [a] = await ready(apps);
    holdRenewAfterPut.after = 2;
    const call = trackOf(execute(a, ChargeWorkflowStart, { text: "order-5" }));
    await until(() => processHoldPoints.held.length === 1, "the put's renewal is held");

    await passLive(clock, seconds(4));
    expect(call.isSettled).toBe(false);
    await passLive(clock, seconds(2));
    await until(() => call.isSettled, "the renewal ends at its bound");

    // 5 s, an ordinary store error: not the trust's end, not a hand-over
    expect(call.error).not.toBeInstanceOf(ExecutionLeaseLostError);
    expect(logged.find((entry) => entry.code === "store.call-timeout")?.message).toContain(
      "unleased call",
    );
  });
});

/** A checkpointer whose writes never answer. */
class SilentCheckpoints extends MemorySaver {
  override put(): Promise<never> {
    return new Promise<never>(() => undefined);
  }

  override putWrites(): Promise<never> {
    return new Promise<never>(() => undefined);
  }
}

/** A `LeasedCheckpointSaver` over the silent saver, bounded as the container bounds it, and its lease. */
async function leasedSilent() {
  const clock = new VirtualClock();
  const application = applicationContextOf({
    ...{ name: "scope-application", version: "1.0.0", instanceId: "instance-1" },
    ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
  });
  const store = new InMemoryExecutionLeaseRepository(
    storeClockOf(clock),
    application,
    new InMemoryDatabase(),
  );
  const lease = await executionLeasesOf(store, clock).hold({
    tenantId: "acme",
    rootExecutionId: "root-scope",
  });
  const bounded = boundedStoreOf(BaseCheckpointSaver, new SilentCheckpoints(), { clock });
  return { clock, lease, saver: new LeasedCheckpointSaver(bounded, lease) };
}

describe("#928 AC1 lease scopes: LeasedCheckpointSaver, on its own", () => {
  const config = { configurable: { thread_id: "t-1", checkpoint_ns: "" } };
  const metadata = { source: "loop", step: 1, parents: {} } as const;

  it("a put that never answers hands over at the trust's end, not at 15 s: the saver is a lease scope itself", async () => {
    const { clock, lease, saver } = await leasedSilent();
    const put = trackOf(saver.put(config, emptyCheckpoint(), metadata, {}));

    await passLive(clock, seconds(16));
    expect(put.isSettled).toBe(false);
    await passLive(clock, seconds(20));
    await until(() => put.isSettled, "the put ends at the trust's end");

    expect(put.error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(lease.signal.aborted).toBe(true);
  });

  it("a putWrites that never answers hands over the same way", async () => {
    const { clock, lease, saver } = await leasedSilent();
    const writes = trackOf(saver.putWrites(config, [["channel", "value"]], "task-1"));

    await passLive(clock, seconds(16));
    expect(writes.isSettled).toBe(false);
    await passLive(clock, seconds(20));
    await until(() => writes.isSettled, "the write ends at the trust's end");

    expect(writes.error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(lease.signal.aborted).toBe(true);
  });
});
