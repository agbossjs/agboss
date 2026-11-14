/**
 * #1017 AC1 — a store error of unknown outcome that the store itself found (a transport error after
 * the request was sent) hands the tree over under a lease, as a timeout does: no `.onError`, no undo,
 * nothing released, the next holder reconciles. Unleased it passes through; an error of known
 * outcome (the store's own refusal) is never a hand-over.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leaseScope } from "../../src/app/lease-scope.js";
import { boundedStoreOf } from "../../src/app/store-call-bound.js";
import {
  ExecutionAuditEventKind,
  ExecutionFencedError,
  ExecutionLeaseLostError,
  FencedEffectStatus,
  StoreCallTimeoutError,
  StoreOutcomeSource,
  StoreOutcomeUnknownError,
} from "../../src/index.js";
import { testWith, VirtualClock } from "../../src/testing/index.js";
import { HoldPhase, processHoldPoints } from "../../src/testing/faults/hold-points.js";
import { reportHeldOperations } from "../../src/testing/faults/held-stores.js";
import { OperationPhase } from "../../src/testing/faults/operation-history.js";
import { StoreHoldPoint } from "../../src/testing/faults/store-points.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { recordingLog } from "../helpers/log.js";
import { passLive } from "../helpers/live-time.js";
import { until } from "../helpers/until.js";
import {
  ends,
  resetRecovery,
  seen as recovery,
} from "../infrastructure/fixtures/recovery.workflow.js";
import { ChargeWorkflowStart, book, resetFencedEffect } from "./fixtures/fenced-effect.workflow.js";
import { StoreBoundApplication } from "./fixtures/store-bound.application.js";
import { heldLease } from "./fixtures/bound-stubs.js";
import { causeOf } from "./fixtures/store-bound-helpers.js";
import { instance, rejectionOf } from "./fixtures/fence-takeover.js";

/** A store whose one call fails as the test says, synchronously or not. */
class Ledger {
  constructor(private readonly failure: Error) {}
  read(): Promise<string> {
    return Promise.reject(this.failure);
  }
  readNow(): Promise<string> {
    throw this.failure;
  }
}

const reset = new StoreOutcomeUnknownError({
  ...{ store: "Ledger", operation: "read", source: StoreOutcomeSource.Transport },
  cause: new Error("read ECONNRESET"),
});

/** A call of `failure`'s store: under a lease (`leased`) or not. */
function called(failure: Error, method: "read" | "readNow") {
  const { log, entries } = recordingLog();
  const store = boundedStoreOf(Ledger, new Ledger(failure), { clock: new VirtualClock(), log });
  const { lease, abandoned } = heldLease(seconds(20));
  return {
    entries,
    abandoned,
    leased: () => rejectionOf(leaseScope(lease, () => store[method]())),
    unleased: () => rejectionOf(Promise.resolve().then(() => store[method]())),
  };
}

describe("#1017 AC1: what the bound makes of a store's own unknown outcome", () => {
  it("a Transport error under a lease: the lease is abandoned, the call rejects ExecutionLeaseLostError, the log names it", async () => {
    const call = called(reset, "read");

    const error = await call.leased();

    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(causeOf(error)).toBe(reset);
    expect(call.abandoned).toEqual([reset]);
    const told = call.entries.filter((entry) => entry.code === "store.outcome-unknown");
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ level: "warn" });
    expect(told[0]?.message).toContain("Ledger.read");
    expect(call.entries.map((entry) => entry.code)).not.toContain("store.call-timeout");
  });

  it("a store that throws it synchronously is a hand-over too; unleased it is thrown as it is", async () => {
    const call = called(reset, "readNow");

    expect(await call.leased()).toBeInstanceOf(ExecutionLeaseLostError);
    expect(call.abandoned).toEqual([reset]);
    expect(await call.unleased()).toBe(reset);
  });

  it("unleased, the same error passes through unchanged and abandons nothing", async () => {
    const call = called(reset, "read");

    expect(await call.unleased()).toBe(reset);
    expect(call.abandoned).toEqual([]);
    expect(call.entries.map((entry) => entry.code)).not.toContain("store.outcome-unknown");
  });

  it("an error of known outcome is no hand-over, a wrapped unknown one is not read through its cause", async () => {
    const refusal = ExecutionFencedError.of({ scopeKey: "acme:root-1", token: 1 });
    const ordinary = new Error("connect ECONNREFUSED", { cause: reset });

    for (const failure of [refusal, ordinary]) {
      const call = called(failure, "read");
      expect(await call.leased()).toBe(failure);
      expect(call.abandoned).toEqual([]);
    }
  });

  it("the family is one: a timeout of the store's own and a transport error hand over alike", async () => {
    const own = new StoreCallTimeoutError({
      ...{ store: "Ledger", operation: "read", timeout: seconds(10) },
      source: StoreOutcomeSource.Command,
    });
    const call = called(own, "read");

    expect(await call.leased()).toBeInstanceOf(ExecutionLeaseLostError);
    expect(call.abandoned).toEqual([own]);
  });
});

const two = testWith(StoreBoundApplication, { instances: 2 });
const operations: string[] = [];
let stop: () => void = () => undefined;

beforeEach(() => {
  resetFencedEffect();
  resetRecovery();
  operations.length = 0;
  stop = reportHeldOperations({
    onOperation: (event) => {
      if (event.phase === OperationPhase.Invoke) operations.push(event.operation);
    },
  });
});

afterEach(() => {
  stop();
  processHoldPoints.releaseAll();
});

describe("#1017 AC1: a charge committed and its answer reset (in memory)", () => {
  two(
    "the holder hands over at once, no failed record, nothing released; the next holder replays the row: one charge",
    async ({ apps, clock }) => {
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await a.ready();
      await b.ready();
      processHoldPoints.arm({
        ...{ point: StoreHoldPoint.FencedEffectWrite, phase: HoldPhase.After },
        loseAnswer: true,
        asTransportError: true,
      });
      const failure = rejectionOf(execute(a, ChargeWorkflowStart, { text: "order-17" }));
      await until(() => book.charges.length === 1, "the charge is committed");

      const error = await failure;

      expect(error).toBeInstanceOf(ExecutionLeaseLostError);
      expect(causeOf(error)).toMatchObject({ source: StoreOutcomeSource.Transport });
      expect(recovery.errors).toEqual([]);
      const audit = await b.auditLogOf({ tenantId: "default", rootExecutionId: "execution-1" });
      expect(audit.filter((row) => row.kind === ExecutionAuditEventKind.HandedOver)).toHaveLength(
        1,
      );
      expect(operations.filter((operation) => /lease\.(release|retire)/u.test(operation))).toEqual(
        [],
      );

      await passLive(clock, seconds(60));
      const [end] = await ends(1);
      expect(end?.output).toEqual({ chargeId: "charge-order-17-1" });
      expect(book.charges).toHaveLength(1);
      expect(book.runs.map((run) => run.status)).toContain(FencedEffectStatus.Replayed);
    },
  );
});
