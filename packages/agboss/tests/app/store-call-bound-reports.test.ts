/**
 * #1069 — what a bounded call tells and what it ends with, word for word: the timeout's line and
 * its counter, the unknown outcome's line, a failed abandon's line, the error a rejection of any
 * value becomes, and the error of a call whose lease was lost while it hung.
 */
import { describe, expect, it } from "vitest";
import { boundedStoreOf } from "../../src/app/store-call-bound.js";
import { StoreCallKind } from "../../src/app/store-call-kind.js";
import { failure, lostOf, type CallFacts } from "../../src/app/store-call-outcome.js";
import { leaseScope } from "../../src/app/lease-scope.js";
import type { FrameLease } from "../../src/flow/context/frame.js";
import type { FrameworkLog } from "../../src/infrastructure/logger.js";
import {
  ExecutionLeaseLostError,
  StoreCallTimeoutError,
  StoreOutcomeSource,
  StoreOutcomeUnknownError,
} from "../../src/index.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";
import { heldLease, outcomeOf, rejectWith, silent } from "./fixtures/bound-stubs.js";

interface Entry {
  readonly code: string;
  readonly message: string;
  readonly meta: unknown;
}

function recorder(): { readonly entries: Entry[]; readonly log: FrameworkLog } {
  const entries: Entry[] = [];
  const log: FrameworkLog = {
    info: () => undefined,
    warn: (code, message, meta) => void entries.push({ code, message, meta }),
    error: () => undefined,
  };
  return { entries, log };
}

abstract class Kv {
  abstract get(): Promise<string>;
}
class MemoryKv extends Kv {
  constructor(private readonly answer: () => Promise<string>) {
    super();
  }
  get(): Promise<string> {
    return this.answer();
  }
}

const unknownError = (source: StoreOutcomeSource): StoreOutcomeUnknownError =>
  new StoreOutcomeUnknownError({ store: "Kv", operation: "get", source });

const factsOf = (lease: FrameLease | undefined): CallFacts => ({
  kind: lease === undefined ? StoreCallKind.Unleased : StoreCallKind.Leased,
  bound: seconds(15),
  lease,
  contract: "Kv",
  store: "Kv",
  operation: "get",
});

describe("#1069: the line and the counter of a call given up", () => {
  it("the bound's own timeout of an unleased call", async () => {
    const { entries, log } = recorder();
    const counted: Record<string, string>[] = [];
    const clock = new VirtualClock();
    const store = boundedStoreOf(Kv, new MemoryKv(() => silent<string>()), {
      clock,
      log,
      timedOut: { add: (_count, attributes) => void counted.push(attributes) },
    });

    const call = outcomeOf(store.get());
    await clock.advance(seconds(16));
    const error = await call;

    expect(error).toBeInstanceOf(StoreCallTimeoutError);
    expect(entries).toEqual([
      {
        code: "store.call-timeout",
        message: `${(error as Error).message} (unleased call; its late answer is dropped)`,
        meta: { executionId: undefined, tenantId: undefined },
      },
    ]);
    expect(counted).toEqual([
      { contract: "Kv", operation: "get", source: "framework", kind: "unleased" },
    ]);
  });

  it("the bound's own timeout of a leased call names the lease's execution and tenant", async () => {
    const { entries, log } = recorder();
    const clock = new VirtualClock();
    const store = boundedStoreOf(Kv, new MemoryKv(() => silent<string>()), { clock, log });
    const { lease } = heldLease(seconds(25));

    const call = outcomeOf(leaseScope(lease, async () => store.get()));
    await clock.advance(seconds(26));
    await call;

    expect(entries.filter((entry) => entry.code === "store.call-timeout")).toMatchObject([
      {
        message: expect.stringContaining("(leased call; its late answer is dropped)") as string,
        meta: { executionId: "root-1", tenantId: "default" },
      },
    ]);
  });

  it("the store's own command timeout is said as the store's", async () => {
    const { entries, log } = recorder();
    const own = new StoreCallTimeoutError({
      store: "Kv",
      operation: "get",
      timeout: seconds(3),
      source: StoreOutcomeSource.Command,
    });
    const store = boundedStoreOf(Kv, new MemoryKv(() => Promise.reject(own)), {
      clock: new VirtualClock(),
      log,
    });

    expect(await outcomeOf(store.get())).toBe(own);

    expect(entries).toEqual([
      {
        code: "store.call-timeout",
        message: `${own.message} (unleased call; the store's own timeout)`,
        meta: { executionId: undefined, tenantId: undefined },
      },
    ]);
  });
});

describe("#1069: a rejection of a call, as `failure` reads it", () => {
  it("an unknown outcome under a lease is a hand-over, and is said", async () => {
    const { entries, log } = recorder();
    const { lease, abandoned } = heldLease(seconds(25));
    const cause = unknownError(StoreOutcomeSource.Transport);

    const error = await failure({ clock: new VirtualClock(), log }, factsOf(lease), cause);

    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect((error as ExecutionLeaseLostError).rootExecutionId).toBe("root-1");
    expect(error.cause).toBe(cause);
    expect(abandoned).toEqual([cause]);
    expect(entries).toEqual([
      {
        code: "store.outcome-unknown",
        message: `${cause.message} (leased call: the tree is handed over, the next holder reconciles it)`,
        meta: { executionId: "root-1", tenantId: "default" },
      },
    ]);
  });

  it("the bound's own unknown outcome is handed over without a second line", async () => {
    const { entries, log } = recorder();
    const { lease, abandoned } = heldLease(seconds(25));
    const cause = unknownError(StoreOutcomeSource.Framework);

    const error = await failure({ clock: new VirtualClock(), log }, factsOf(lease), cause);

    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(abandoned).toEqual([cause]);
    expect(entries).toEqual([]);
  });

  it("an unknown outcome with no lease is the store's error, nothing else", async () => {
    const { entries, log } = recorder();
    const cause = unknownError(StoreOutcomeSource.Transport);

    expect(await failure({ clock: new VirtualClock(), log }, factsOf(undefined), cause)).toBe(
      cause,
    );
    expect(entries).toEqual([]);
  });

  it("a value that is not an Error is one with its text, and itself as the cause", async () => {
    const error = await failure({ clock: new VirtualClock() }, factsOf(undefined), "boom");

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("boom");
    expect(error.cause).toBe("boom");
  });

  it("an abandon that rejects is said, and the call is still a hand-over", async () => {
    const { entries, log } = recorder();
    const { lease } = heldLease(seconds(25));
    lease.abandon = () => Promise.reject(new Error("nope"));
    const cause = unknownError(StoreOutcomeSource.Framework);

    const error = await failure({ clock: new VirtualClock(), log }, factsOf(lease), cause);

    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(entries).toEqual([
      {
        code: "execution.lease-abandon-failed",
        message: "abandoning the lease failed (nope); it expires in its store",
        meta: { executionId: "root-1", tenantId: "default" },
      },
    ]);
  });

  it("an abandon that rejects with a text says the text", async () => {
    const { entries, log } = recorder();
    const { lease } = heldLease(seconds(25));
    lease.abandon = () => rejectWith("plain words");

    await failure(
      { clock: new VirtualClock(), log },
      factsOf(lease),
      unknownError(StoreOutcomeSource.Framework),
    );

    expect(entries[0]?.message).toBe(
      "abandoning the lease failed (plain words); it expires in its store",
    );
  });

  it("a lease with nothing to abandon with is a hand-over that says nothing failed", async () => {
    const { entries, log } = recorder();
    const { lease } = heldLease(seconds(25));
    delete lease.abandon;

    const error = await failure(
      { clock: new VirtualClock(), log },
      factsOf(lease),
      unknownError(StoreOutcomeSource.Framework),
    );

    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(entries).toEqual([]);
  });
});

describe("#1069: the error of a call whose lease was lost while it hung", () => {
  it("is the lease's own reason when it is an error", () => {
    const reason = new Error("the lease was taken");

    expect(lostOf(factsOf(heldLease(seconds(25)).lease), reason)).toBe(reason);
  });

  it("is a lost lease of the lease's execution when the reason is not an error", () => {
    const error = lostOf(factsOf(heldLease(seconds(25)).lease), "taken");

    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect((error as ExecutionLeaseLostError).rootExecutionId).toBe("root-1");
  });

  it("is a lost lease of no execution when the call had no lease", () => {
    const error = lostOf(factsOf(undefined), undefined);

    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect((error as ExecutionLeaseLostError).rootExecutionId).toBe("");
  });
});
