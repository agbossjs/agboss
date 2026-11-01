/**
 * #626 (keys-and-calls shard) — the outbound call's runtime pieces on their own, where an end to
 * end run cannot reach a branch: who a replay names, how an error names a key, what a superseded
 * attempt, a fenced end and a closed lease tell and log, and how a call this instance makes is
 * joined, left and aborted.
 */
import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import {
  checkedCall,
  replayedFromOf,
  reportedKeyOf,
} from "../../src/app/outbound-call-business.js";
import { fencedEnd, leaseSuperseded, superseded } from "../../src/app/outbound-call-endings.js";
import { joinedOrMade } from "../../src/app/outbound-call-join.js";
import { OutboundCallOutcomeStatus } from "../../src/app/outbound-calls.js";
import { ExecutionFencedError } from "../../src/app/lease-lost.js";
import { OutboundCallEventOutcome } from "../../src/infrastructure/execution-lease-event.repository.js";
import { OutboundCallStatus } from "../../src/infrastructure/outbound-call.repository.js";
import { testFrame } from "../helpers/frame.js";
import { recordingLog } from "../helpers/log.js";

const ORIGIN = { executionId: "execution-1", nodeId: "charge-action", visitNumber: 1 };

/** A stored call made by the step `origin` names. */
const storedBy = (origin: typeof ORIGIN) =>
  ({
    executionId: origin.executionId,
    step: { nodeId: origin.nodeId, visitNumber: origin.visitNumber },
  }) as never;

describe("#626: the step a replayed call names", () => {
  it.each([
    ["another execution", { ...ORIGIN, executionId: "execution-2" }],
    ["another node", { ...ORIGIN, nodeId: "refund-action" }],
    ["another visit", { ...ORIGIN, visitNumber: 2 }],
  ])("a call made by %s is named", (_, stored) => {
    expect(replayedFromOf({ origin: ORIGIN } as never, storedBy(stored))).toEqual(stored);
  });

  it("the key's own step is not named; a key with no step is told the stored one", () => {
    expect(replayedFromOf({ origin: ORIGIN } as never, storedBy(ORIGIN))).toBeUndefined();
    expect(replayedFromOf({} as never, storedBy(ORIGIN))).toEqual(ORIGIN);
  });
});

describe("#626: how an error names a call's key", () => {
  it("a step's key as it is; a business key by its handle, or by its name with no handle", () => {
    const business = { businessKey: "order:42", name: "charge" };

    expect(reportedKeyOf({ name: "charge" } as never, "k:charge")).toBe("k:charge");
    expect(reportedKeyOf({ ...business, businessKeyHash: "h1" } as never, "k")).toBe(
      "business-key:h1:charge",
    );
    expect(reportedKeyOf(business as never, "k")).toBe("business-key:charge");
  });

  it("a step's key finds no conflict in a stored fingerprint: a store's leftover, never compared", async () => {
    const run = { key: { name: "charge" }, options: {}, parts: { owners: new Set() } } as never;
    const found = { fingerprint: "left-by-a-store", status: OutboundCallStatus.Completed } as never;

    await expect(checkedCall(run, found)).resolves.toBeUndefined();
  });
});

/** A step's frame whose lease records the moves told, on `signal`. */
function frameWith(lease: object, signal?: AbortSignal) {
  const frame = testFrame();
  const execution = { ...frame.execution, executionId: "execution-1", lease };
  return { ...frame, execution: signal === undefined ? execution : { ...execution, signal } };
}

/** A run whose moves and log the test reads; the store answers `findByKey` with `found`. */
function endingRun(findByKey: () => Promise<unknown>) {
  const moves: Record<string, unknown>[] = [];
  const { log, entries } = recordingLog();
  const run = {
    frame: frameWith({
      recordOutboundCall: (move: Record<string, unknown>) => moves.push(move),
    }),
    parts: { repository: { findByKey }, log },
    key: { name: "charge", tenantId: "default", scopeKey: "s", token: 2 },
    options: { target: "payments", operation: "charge" },
  } as never;
  return { run, moves, entries };
}

const movedOf = (moves: readonly Record<string, unknown>[]) =>
  moves.map(({ outcome, status, attempt, supersededBy }) => ({
    outcome,
    status,
    attempt,
    ...(supersededBy === undefined ? {} : { supersededBy }),
  }));

describe("#626: a superseded attempt tells the intent as it reads, naming the newer attempt", () => {
  it("a newer attempt completed it: told with its status and the attempt that took it over", async () => {
    const found = { status: OutboundCallStatus.Completed, attempt: 3 };
    const { run, moves, entries } = endingRun(() => Promise.resolve(found));

    await superseded(run, 1);

    expect(movedOf(moves)).toEqual([
      {
        outcome: OutboundCallEventOutcome.Superseded,
        status: OutboundCallStatus.Completed,
        attempt: 1,
        supersededBy: 3,
      },
    ]);
    expect(entries[0]?.message).toContain("attempt 1 was answered after attempt 3 took its intent");
  });

  it("the intent still at this attempt (another owner): which attempt is unknown, never a guess", async () => {
    const found = { status: OutboundCallStatus.Pending, attempt: 1 };
    const { run, moves, entries } = endingRun(() => Promise.resolve(found));

    await superseded(run, 1);

    expect(movedOf(moves)).toEqual([
      {
        outcome: OutboundCallEventOutcome.Superseded,
        status: OutboundCallStatus.Pending,
        attempt: 1,
      },
    ]);
    expect(entries[0]?.message).toContain("after a newer attempt (which one is unknown)");
  });

  it("the intent cannot be read: told pending, which attempt unknown", async () => {
    const { run, moves } = endingRun(() => Promise.reject(new Error("store down")));

    await superseded(run, 2);

    expect(movedOf(moves)).toEqual([
      {
        outcome: OutboundCallEventOutcome.Superseded,
        status: OutboundCallStatus.Pending,
        attempt: 2,
      },
    ]);
  });
});

describe("#626: an attempt's fenced end", () => {
  it("a write the lease refused is logged as an answer after the hand-over, then thrown", async () => {
    const { run, entries } = endingRun(() => Promise.resolve(undefined));
    const fenced = new ExecutionFencedError({ scopeKey: "default:execution-1", token: 2 });

    await expect(fencedEnd(run, 1, () => Promise.reject(fenced))).rejects.toBe(fenced);

    expect(entries).toEqual([
      {
        level: "error",
        code: "outbound-call.answered-after-hand-over",
        message:
          'outbound call "charge" (charge on payments) attempt 1 was answered after its lease was handed over: the answer is not stored and the new holder reconciles the intent — check payments if it was sent again',
      },
    ]);
  });

  it("any other failure of the write is thrown as it is, nothing logged", async () => {
    const { run, entries } = endingRun(() => Promise.resolve(undefined));
    const broken = new Error("disk full");

    await expect(fencedEnd(run, 1, () => Promise.reject(broken))).rejects.toBe(broken);
    expect(entries).toEqual([]);
  });

  it("a write that succeeds answers as it did", async () => {
    const { run } = endingRun(() => Promise.resolve(undefined));

    await expect(fencedEnd(run, 1, () => Promise.resolve(false))).resolves.toBe(false);
  });
});

describe("#626: a lease closed by a call's check", () => {
  it("is told with the lease and its token, and warned of in full", () => {
    const { run, moves, entries } = endingRun(() => Promise.resolve(undefined));
    const found = {
      status: OutboundCallStatus.Pending,
      attempt: 4,
      rootExecutionId: "execution-9",
      leaseExecutionId: "execution-9",
      token: 7,
    } as never;

    leaseSuperseded(run, found);

    expect(moves).toEqual([
      expect.objectContaining({
        outcome: OutboundCallEventOutcome.LeaseSuperseded,
        status: OutboundCallStatus.Pending,
        attempt: 4,
        supersededLease: {
          rootExecutionId: "execution-9",
          leaseExecutionId: "execution-9",
          token: 7,
        },
      }),
    ]);
    expect(entries).toEqual([
      {
        level: "warn",
        code: "outbound-call.lease-superseded",
        message:
          'outbound call "charge" (charge on payments) attempt 4 was pending under the lease of execution execution-9 at token 7, expired: closed, the call is reconciled here — a send of it still hung may reach payments too, deduplicated only by call.idempotencyKey',
      },
    ]);
  });
});

const KEY = { name: "charge", tenantId: "default", scopeKey: "s", idempotencyKey: "k" };

/** Runs of call `charge` on one instance's live calls, each with its own step signal and moves. */
function liveCalls() {
  const live = new Map<string, unknown>();
  const runOf = () => {
    const controller = new AbortController();
    const moves: Record<string, unknown>[] = [];
    const lease = { recordOutboundCall: (move: Record<string, unknown>) => moves.push(move) };
    const run = {
      parts: { live },
      key: KEY,
      frame: frameWith(lease, controller.signal),
      options: { target: "payments", operation: "charge" },
      idempotencyKey: "k:charge",
      answer: { isAnswered: false },
    } as never;
    return { run, controller, moves };
  };
  return { live, runOf };
}

/** A promise and its settlers. */
function deferred<TValue>() {
  let resolve: (value: TValue) => void = () => undefined;
  const promise = new Promise<TValue>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const SENT = { status: OutboundCallOutcomeStatus.Sent, result: 1, attempt: 2, idempotencyKey: "k" };

describe("#626: a call this instance is making, joined and left", () => {
  it("a joiner whose step was already aborted is refused at once, never handed the first's outcome", async () => {
    const { runOf } = liveCalls();
    const first = runOf();
    const made = joinedOrMade(first.run, () => Promise.resolve(SENT));
    const joiner = runOf();
    joiner.controller.abort(new Error("cancelled before it joined"));

    await expect(joinedOrMade(joiner.run, () => Promise.resolve(SENT))).rejects.toThrow(
      "cancelled before it joined",
    );
    await made;
  });

  it("a joiner aborted while it waits stops waiting with its abort, the first still in flight", async () => {
    const { runOf } = liveCalls();
    const sending = deferred<typeof SENT>();
    const first = runOf();
    const made = joinedOrMade(first.run, () => sending.promise);
    const joiner = runOf();
    const joined = joinedOrMade(joiner.run, () => Promise.resolve(SENT));

    joiner.controller.abort(new Error("cancelled while it waited"));

    await expect(joined).rejects.toThrow("cancelled while it waited");
    sending.resolve(SENT);
    await expect(made).resolves.toBe(SENT);
  });

  it("a joiner of a call that was sent is told Joined, with the first's attempt", async () => {
    const { runOf } = liveCalls();
    const sending = deferred<typeof SENT>();
    const made = joinedOrMade(runOf().run, () => sending.promise);
    const joiner = runOf();
    const joined = joinedOrMade(joiner.run, () => Promise.reject(new Error("not made")));

    sending.resolve(SENT);

    await expect(joined).resolves.toMatchObject({
      status: OutboundCallOutcomeStatus.Joined,
      attempt: 2,
    });
    expect(joiner.moves).toEqual([
      expect.objectContaining({
        outcome: OutboundCallEventOutcome.Joined,
        status: OutboundCallStatus.Completed,
        attempt: 2,
      }),
    ]);
    await made;
  });

  it("an aborted call leaves the live calls; when it ends it never takes out the call made after it", async () => {
    const { live, runOf } = liveCalls();
    const firstSend = deferred<typeof SENT>();
    const first = runOf();
    const aborted = joinedOrMade(first.run, () => firstSend.promise);
    first.controller.abort(new Error("its step was cancelled"));
    expect(live.size).toBe(0);
    const second = runOf();
    const secondSend = deferred<typeof SENT>();
    const made = joinedOrMade(second.run, () => secondSend.promise);
    const [madeAfter] = live.values();

    firstSend.resolve(SENT);
    await aborted;

    expect([...live.values()]).toEqual([madeAfter]);
    secondSend.resolve(SENT);
    await made;
    expect(live.size).toBe(0);
  });

  it("a call made here leaves no abort listener on its step's signal once it ended", async () => {
    const { runOf } = liveCalls();
    const first = runOf();
    const { signal } = first.controller;
    const before = getEventListeners(signal, "abort").length;

    await joinedOrMade(first.run, () => Promise.resolve(SENT));

    expect(getEventListeners(signal, "abort")).toHaveLength(before);
  });
});
