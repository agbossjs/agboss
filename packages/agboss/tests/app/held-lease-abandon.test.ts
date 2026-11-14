/**
 * #928 AC1 (abandon) — a held lease handed over because a store call under it did not answer: its
 * signal aborts with the hand-over, its renewals stop, its token is no more a fenced holder's, its
 * audit rows are written (each within the 15 s of an unleased call); nothing is released, retired
 * or announced — the lease expires in its store and the next holder reconciles.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { executionLeasesOf, type AuditLogWriter } from "../../src/app/execution-leases.js";
import { handedOverOf, isHandedOver } from "../../src/app/handed-over.js";
import { HeldLease } from "../../src/app/held-lease.js";
import { leaseReleases } from "../../src/app/lease-releases.js";
import { boundedStoreOf } from "../../src/app/store-call-bound.js";
import { ExecutionObserverManager } from "../../src/core/observer-manager.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { nodeEventOf } from "../../src/flow/observers/execution-event.js";
import {
  ExecutionFencedError,
  ExecutionLeaseLostError,
  StoreCallTimeoutError,
  StoreOutcomeSource,
} from "../../src/index.js";
import {
  ExecutionAuditEventKind,
  ExecutionAuditLogRepository,
  HandOverSite,
  InMemoryExecutionAuditLogRepository,
} from "../../src/infrastructure/execution-audit-log.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryDatabase, treeKeyOf } from "../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";
import { testFrame } from "../helpers/frame.js";
import { passLive } from "../helpers/live-time.js";
import { until } from "../helpers/until.js";
import { recordingLog } from "../helpers/log.js";
import { storeClockOf } from "../helpers/store-clock.js";

const TREE = { tenantId: "acme", rootExecutionId: "root-abandon" };

/** The lease store that counts what reaches it. */
class CountingLeases extends InMemoryExecutionLeaseRepository {
  readonly calls = { renew: 0, release: 0, retire: 0 };

  override renew(...args: Parameters<InMemoryExecutionLeaseRepository["renew"]>) {
    this.calls.renew += 1;
    return super.renew(...args);
  }

  override release(...args: Parameters<InMemoryExecutionLeaseRepository["release"]>) {
    this.calls.release += 1;
    return super.release(...args);
  }

  override retire(...args: Parameters<InMemoryExecutionLeaseRepository["retire"]>) {
    this.calls.retire += 1;
    return super.retire(...args);
  }
}

/** The audit log whose writes can stop answering. */
class QuietAuditLog extends InMemoryExecutionAuditLogRepository {
  isQuiet = false;
  asked = 0;

  override save(...args: Parameters<InMemoryExecutionAuditLogRepository["save"]>) {
    this.asked += 1;
    return this.isQuiet ? new Promise<never>(() => undefined) : super.save(...args);
  }
}

const unknown = (operation: string): StoreCallTimeoutError =>
  new StoreCallTimeoutError({
    ...{ store: "RateLimitRepository", operation, timeout: seconds(20) },
    source: StoreOutcomeSource.Framework,
  });

async function held() {
  const clock = new VirtualClock();
  const database = new InMemoryDatabase();
  const application = applicationContextOf({
    ...{ name: "abandon-application", version: "1.0.0", instanceId: "instance-1" },
    ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
  });
  const store = new CountingLeases(storeClockOf(clock), application, database);
  const audit = new QuietAuditLog(database);
  const { log, entries } = recordingLog();
  const events: AuditLogWriter = {
    repository: boundedStoreOf(ExecutionAuditLogRepository, audit, { clock }),
    observer: new ExecutionObserverManager([]),
    mask: (event) => Promise.resolve(event),
    ...{ log, clock, recording: import("../../src/app/audit-log.js") },
  };
  const lease = await executionLeasesOf(store, clock, { events }).hold(TREE);
  const abandon = (cause = unknown("acquire")) => lease.abandon?.(cause) ?? Promise.resolve();
  return { clock, database, store, audit, entries, lease, abandon };
}

const settled = async (): Promise<void> => {
  for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#928 AC1: abandon", () => {
  it("AC1: abandon stops renewals, forgets the holder, skips release/retire and leaseReleases.notify; a later release() logs execution.lease-abandoned and returns", async () => {
    const fenced = vi.spyOn(HeldLease.prototype, "fenced");
    const { clock, store, entries, lease, abandon } = await held();
    await passLive(clock, seconds(10));
    expect(store.calls.renew).toBe(1);
    const watch = leaseReleases.watch(treeKeyOf(TREE.tenantId, TREE.rootExecutionId));
    const giveUp = new AbortController();
    const woken = watch.wait(
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            resolve();
          });
        }),
      giveUp.signal,
    );
    let isWoken = false;
    void woken.then(() => {
      isWoken = true;
    });

    await abandon();
    await passLive(clock, seconds(60));
    // a fenced write of the abandoned token: its holder is forgotten, nothing is stopped again
    handedOverOf(ExecutionFencedError.of({ scopeKey: "acme:root-abandon", token: 1 }), undefined);
    await lease.release();
    await lease.release({ isRetired: true });
    await settled();
    const isWokenByRelease = isWoken;
    giveUp.abort();
    await woken;
    watch.close();

    expect(store.calls).toEqual({ renew: 1, release: 0, retire: 0 });
    expect(fenced).not.toHaveBeenCalled();
    expect(isWokenByRelease).toBe(false);
    const told = entries.filter((entry) => entry.code === "execution.lease-abandoned");
    expect(told).toHaveLength(2);
    expect(told[0]).toMatchObject({ level: "warn" });
    expect(told[0]?.message).toContain("RateLimitRepository.acquire");
    expect(told[0]?.message).toContain(`execution ${TREE.rootExecutionId} (token 1)`);
  });

  it("AC1: the abort reason is ExecutionLeaseLostError with the cause, a hand-over", async () => {
    const { lease, abandon } = await held();
    const cause = unknown("acquire");

    await abandon(cause);

    const { reason } = lease.signal;
    expect(reason).toBeInstanceOf(ExecutionLeaseLostError);
    expect(reason).toMatchObject({ cause, rootExecutionId: TREE.rootExecutionId });
    expect(isHandedOver(reason)).toBe(true);
    expect(lease.token).toBe(1);
  });

  it("AC1: abandon is idempotent: two concurrent calls, one hand-over, the first cause kept", async () => {
    const { lease, entries, abandon } = await held();
    const [first, second] = [unknown("acquire"), unknown("renew")];

    const calls = [abandon(first), abandon(second)];
    await Promise.all(calls);
    expect(calls[0]).toBe(calls[1]);
    await lease.release();

    expect(lease.signal.reason).toMatchObject({ cause: first });
    expect(entries.find((entry) => entry.code === "execution.lease-abandoned")?.message).toContain(
      "acquire",
    );
  });

  it("AC1: it awaits the reports: the hand-over's row is written first; each write is bounded at 15 s", async () => {
    const quiet = await held();
    quiet.audit.isQuiet = true;
    const error = new ExecutionLeaseLostError({ rootExecutionId: TREE.rootExecutionId });
    quiet.lease.recordHandOver?.({
      event: nodeEventOf(testFrame()),
      error,
      site: HandOverSite.Step,
    });
    let isDone = false;
    void quiet.abandon().then(() => (isDone = true));

    await until(() => quiet.audit.asked === 1, "the row is asked of the store");
    await quiet.clock.advance(seconds(14));
    await settled();
    expect(isDone).toBe(false);
    await quiet.clock.advance(seconds(1));
    await settled();
    expect(isDone).toBe(true);

    const written = await held();
    written.lease.recordHandOver?.({
      ...{ event: nodeEventOf(testFrame()), error, site: HandOverSite.Step },
    });
    await written.abandon();
    const rows = written.database.executionAuditLog.filter(
      (row) => row.kind === ExecutionAuditEventKind.HandedOver,
    );
    expect(rows).toHaveLength(1);
  });
});
