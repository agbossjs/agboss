/**
 * #1356 (mutation shards `keys-and-calls`, `fenced-reach`): what `Idempotency` refuses before it records, runs or
 * sends anything — each bad option with its own text and in its order —, what it refuses when it is called from
 * where it must not be, and the service an application's own container does not have. Each rule on its own, over
 * the in-memory stores of `outboundFrame`.
 */
import { describe, expect, it, vi, type Mock } from "vitest";
import { Idempotency, IDEMPOTENCY_OUTSIDE_APPLICATION } from "../../src/app/idempotency.js";
import { cancelFencedOf } from "../../src/app/cancel-fenced.js";
import { keyedByRequest } from "../../src/app/outbound-call-business.js";
import { cancelledBy } from "../../src/app/outbound-call-endings.js";
import { owning } from "../../src/app/outbound-call-join.js";
import { supersededError } from "../../src/app/outbound-call-errors.js";
import { TEST_IDEMPOTENCY_KEY } from "../../src/application/idempotency-key.js";
import { runInFrame } from "../../src/flow/context/frame.js";
import { effectKeyForTesting } from "../../src/testing/contracts/effect-key.js";
import { testFrame } from "../helpers/frame.js";
import { boundedWork, isThenable } from "../../src/app/idempotency-work.js";
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { IdempotencyError } from "../../src/core/error-families/effect-errors.js";
import { OutboundCallError } from "../../src/core/error-families/outbound-call-errors.js";
import { OutboundRecovery } from "../../src/index.js";
import { hours, kilobytes, seconds, Ttl } from "../../src/units/index.js";
import { lookupKeyOf, outboundFrame, rejectionOf } from "../helpers/outbound-frame.js";

const NOTHING = "— nothing was recorded, run or sent";

const runOnceOf = (changes: Record<string, unknown>) =>
  rejectionOf(
    outboundFrame().idempotency.runOnce({
      name: "charge",
      ttl: hours(24),
      execute: () => 1,
      ...changes,
    } as never),
  );

const sendOnceOf = (changes: Record<string, unknown>) =>
  rejectionOf(
    outboundFrame().idempotency.sendOnce({
      name: "pay",
      target: "gateway",
      request: { amount: 1 },
      timeout: seconds(5),
      ttl: hours(48),
      send: () => Promise.resolve({ ok: true }),
      recovery: OutboundRecovery.permanentLookup(() => Promise.reject(new Error("not asked"))),
      ...changes,
    } as never),
  );

describe("#1317: runOnce refuses a bad option before anything is recorded or run, each with its own text", () => {
  it.each([
    [0, 'ttl is 0, not a positive duration'],
    [-1, "ttl is -1, not a positive duration"],
    ["1h", 'ttl is "1h", not a positive duration'],
    [Number.NaN, "ttl is NaN, not a positive duration"],
    [seconds(30), "ttl is 30000 ms, not above the lease's 30000 ms"],
  ])("ttl %s: %s", async (ttl, problem) => {
    const error = await runOnceOf({ ttl });

    expect(error).toBeInstanceOf(ConfigError.Option);
    expect((error as Error).message).toBe(`Idempotency.runOnce: ${problem} ${NOTHING}`);
  });

  it.each([
    [0, "timeout is 0, not a positive duration"],
    [-5, "timeout is -5, not a positive duration"],
    [Number.NaN, "timeout is NaN, not a positive duration"],
    [Number.POSITIVE_INFINITY, "timeout is Infinity, not a positive duration"],
    ["5s", 'timeout is 5s, not a positive duration'],
    [
      172_800_000,
      "timeout is 172800000 ms, above its largest of 1 day (86400000 ms) — a longer timer would fire at once",
    ],
    [seconds(30), "timeout is not below the lease"],
    [seconds(31), "timeout is not below the lease"],
  ])("timeout %s: %s", async (timeout, problem) => {
    const error = await runOnceOf({ timeout });

    expect(error).toBeInstanceOf(ConfigError.Option);
    expect((error as Error).message).toBe(`Idempotency.runOnce: ${problem} ${NOTHING}`);
  });

  it("an execute that is no function", async () => {
    const error = await runOnceOf({ execute: "charge it" });

    expect(error).toBeInstanceOf(ConfigError.Option);
    expect((error as Error).message).toBe(`Idempotency.runOnce: execute is not a function ${NOTHING}`);
  });

  it("the ttl is told before the timeout, the timeout before the lease, the lease before the execute", async () => {
    const both = await runOnceOf({ ttl: 0, timeout: 0, execute: 1 });
    const timeoutFirst = await runOnceOf({ timeout: 0, execute: 1 });
    const leaseFirst = await runOnceOf({ timeout: seconds(30), execute: 1 });

    expect((both as Error).message).toContain("ttl is 0");
    expect((timeoutFirst as Error).message).toContain("timeout is 0");
    expect((leaseFirst as Error).message).toContain("timeout is not below the lease");
  });

  it("a ttl of Ttl.Forever and a timeout just below the lease are options: the call goes on to the step it must run in", async () => {
    const forever = await runOnceOf({ ttl: Ttl.Forever });
    const below = await runOnceOf({ timeout: seconds(29) });
    const unset = await runOnceOf({ timeout: undefined });

    for (const error of [forever, below, unset]) {
      expect(error).not.toBeInstanceOf(ConfigError.Option);
      expect((error as Error).message).toMatch(/^Idempotency read .* outside an execution\./);
    }
  });

  it("a key whose fingerprint has no key to belong to is refused naming runOnce", async () => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1");

    const error = await rejectionOf(
      frame.inFrame(key, () =>
        frame.idempotency.runOnce({
          name: "charge",
          ttl: hours(24),
          fingerprint: { amount: 1 },
          execute: () => 1,
        } as never),
      ),
    );

    expect((error as Error).message).toBe(
      `Idempotency.runOnce: a fingerprint needs a key: it says what the work under it does ${NOTHING}`,
    );
  });

  it("a timed-out execute rejects with a TimeoutError that names the effect and its bound", async () => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1");
    const stalled = frame
      .inFrame(key, () =>
        frame.idempotency.runOnce({
          name: "charge",
          ttl: hours(24),
          timeout: seconds(5),
          execute: () => new Promise<never>(() => undefined),
        }),
      )
      .catch((error: unknown) => error);

    await frame.clock.advance(seconds(6));
    const error = await stalled;

    expect(error).toMatchObject({
      name: "TimeoutError",
      message: 'idempotent effect "charge" passed its timeout of 5000 ms: rolled back',
    });
  });

  it("a runOnce inside a runOnce is refused, naming both", async () => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1");
    let inner: unknown;

    await frame.inFrame(key, () =>
      frame.idempotency.runOnce({
        name: "outer",
        ttl: hours(24),
        execute: async () => {
          inner = await rejectionOf(
            frame.idempotency.runOnce({ name: "inner", ttl: hours(24), execute: () => 2 }),
          );
          return 1;
        },
      }),
    );

    expect(inner).toBeInstanceOf(IdempotencyError.NestedRunOnce);
    expect((inner as Error).message).toBe(
      `Idempotency.runOnce "inner" was called inside runOnce "outer": an effect's write is one transaction, and a second one inside it would wait for the first, or exhaust a single-connection pool — nothing ran`,
    );
  });
});

describe("#1317: sendOnce refuses a bad option before anything is recorded or sent, each with its own text", () => {
  it("a send inside a runOnce is refused: the effect's transaction is open", async () => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1");
    let inner: unknown;

    await frame.inFrame(key, () =>
      frame.idempotency.runOnce({
        name: "outer",
        ttl: hours(24),
        execute: async () => {
          inner = await rejectionOf(
            frame.idempotency.sendOnce({
              name: "pay",
              target: "gateway",
              request: {},
              timeout: seconds(5),
              ttl: hours(48),
              send: () => Promise.resolve(1),
              recovery: OutboundRecovery.permanentLookup(() => Promise.reject(new Error("no"))),
            } as never),
          );
          return 1;
        },
      }),
    );

    expect(inner).toBeInstanceOf(IdempotencyError.ExternalCallInTransaction);
    expect((inner as Error).message).toMatch(
      /^Idempotency\.sendOnce "pay" inside runOnce "outer": the effect's transaction is open/,
    );
  });

  it.each([
    [undefined, "timeout is undefined, not a positive duration"],
    [0, "timeout is 0, not a positive duration"],
    [-1, "timeout is -1, not a positive duration"],
    [Number.NaN, "timeout is NaN, not a positive duration"],
    [
      172_800_000,
      "timeout is 172800000 ms, above its largest of 1 day (86400000 ms) — a longer timer would fire at once",
    ],
  ])("timeout %s: %s", async (timeout, problem) => {
    const error = await sendOnceOf({ timeout });

    expect(error).toBeInstanceOf(ConfigError.Option);
    expect((error as Error).message).toBe(`Idempotency.sendOnce: ${problem} ${NOTHING}`);
  });

  it.each([
    [0, "ttl is 0, not a positive duration"],
    ["2d", 'ttl is "2d", not a positive duration'],
    [seconds(30), "ttl is 30000 ms, not above the lease's 30000 ms"],
  ])("ttl %s: %s", async (ttl, problem) => {
    const error = await sendOnceOf({ ttl });

    expect(error).toBeInstanceOf(ConfigError.Option);
    expect((error as Error).message).toBe(`Idempotency.sendOnce: ${problem} ${NOTHING}`);
  });

  it("a send that is no function, a target that is no name", async () => {
    const send = await sendOnceOf({ send: "now" });
    const empty = await sendOnceOf({ target: "" });
    const number = await sendOnceOf({ target: 7 });
    const missing = await sendOnceOf({ target: undefined });

    expect((send as Error).message).toBe(`Idempotency.sendOnce: send is not a function ${NOTHING}`);
    for (const error of [empty, number, missing]) {
      expect(error).toBeInstanceOf(ConfigError.Option);
      expect((error as Error).message).toBe(`Idempotency.sendOnce: target is not a name ${NOTHING}`);
    }
  });

  it("a ttl of Ttl.Forever and an operation left out are options: the call goes on to the step it must run in", async () => {
    const forever = await sendOnceOf({ ttl: Ttl.Forever });
    const plain = await sendOnceOf({});

    for (const error of [forever, plain]) {
      expect(error).not.toBeInstanceOf(ConfigError.Option);
      expect((error as Error).message).toMatch(/^Idempotency read .* outside an execution\./);
    }
  });
});

describe("#1317: what sendOnce takes when an option is left out", () => {
  const send = async (changes: Record<string, unknown>) => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1");
    const outcome = await frame
      .send(key, {
        target: "gateway",
        request: { amount: 1 },
        send: () => Promise.resolve({ ok: true }),
        recovery: OutboundRecovery.permanentLookup(() => Promise.reject(new Error("no"))),
        ...changes,
      } as never)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    return { frame, key, outcome };
  };

  it("the operation is the call's name unless it says one", async () => {
    const left = await send({});
    const named = await send({ operation: "authorize" });

    const of = async ({ frame, key }: Awaited<ReturnType<typeof send>>) =>
      (await frame.store.findByKey(lookupKeyOf(key)))?.operation;
    expect(await of(left)).toBe(left.key.name);
    expect(await of(named)).toBe("authorize");
  });

  it("a request above 64 KB is refused unless the call raises the bound", async () => {
    const big = { data: "x".repeat(70_000) };

    const refused = await send({ request: big });
    const raised = await send({ request: big, maxPayloadSize: kilobytes(128) });

    expect(refused.outcome).toBeInstanceOf(OutboundCallError.PayloadTooLarge);
    expect(refused.outcome).toMatchObject({ part: "request", maxPayloadSize: 65_536 });
    expect(raised.outcome).toBeUndefined();
  });
});

describe("#1317: the work of a runOnce and its bound", () => {
  it.each([
    ["a promise", Promise.resolve(1), true],
    ["an object with a then function", { then: () => undefined }, true],
    ["an object whose then is no function", { then: 1 }, false],
    ["an object with no then", {}, false],
    ["null", null, false],
    ["a text", "then", false],
    ["a function with a then", Object.assign(() => 1, { then: () => 1 }), false],
    ["undefined", undefined, false],
  ])("%s: thenable %s", (_what, value, expected) => {
    expect(isThenable(value)).toBe(expected);
  });

  /** A clock whose sleeps are held until the test ends one. */
  const clockOf = () => {
    const sleeps: { delay: number; signal: AbortSignal | undefined; end: () => void }[] = [];
    return {
      sleeps,
      clock: {
        sleep: (delay: number, signal?: AbortSignal) =>
          new Promise<void>((resolve) => {
            sleeps.push({ delay, signal, end: resolve });
          }),
      },
    };
  };

  it("a synchronous work is returned as it is, no timer armed", () => {
    const { clock, sleeps } = clockOf();
    const value = { n: 1 };

    const result = boundedWork(clock, { name: "charge", timeout: seconds(5) }, () => value as never)();

    expect(result).toBe(value);
    expect(sleeps).toEqual([]);
  });

  it("an asynchronous work races a timer of the timeout; the timer is stopped when the work ends", async () => {
    const { clock, sleeps } = clockOf();

    const result = await boundedWork(
      clock,
      { name: "charge", timeout: seconds(5) },
      () => Promise.resolve("done") as never,
    )();

    expect(result).toBe("done");
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]?.delay).toBe(5000);
    expect(sleeps[0]?.signal?.aborted).toBe(true);
  });

  it("a work that outlasts the timeout fails with a TimeoutError naming the effect and the bound", async () => {
    const { clock, sleeps } = clockOf();
    const stalled = boundedWork(
      clock,
      { name: "charge", timeout: seconds(5) },
      () => new Promise<never>(() => undefined),
    )();

    sleeps[0]?.end();

    await expect(stalled).rejects.toMatchObject({
      name: "TimeoutError",
      message: 'idempotent effect "charge" passed its timeout of 5000 ms: rolled back',
    });
    expect(sleeps[0]?.signal?.aborted).toBe(true);
  });

  it("a timer whose sleep ended after the work did is no timeout", async () => {
    const { clock, sleeps } = clockOf();
    let finish: (value: string) => void = () => undefined;
    const slow = boundedWork(
      clock,
      { name: "charge", timeout: seconds(5) },
      () => new Promise<string>((resolve) => (finish = resolve)) as never,
    )();

    finish("late but in time");
    const result = await slow;
    sleeps[0]?.end();
    await Promise.resolve();

    expect(result).toBe("late but in time");
  });
});

describe("#1317: the lease of a call's frame is optional, its owner and its late answer", () => {
  const cancel = () =>
    cancelFencedOf({ scopeKey: "s", tenantId: "t", leaseExecutionId: "e", token: 1, name: "pay" });
  const runWith = (lease: unknown, answer: Record<string, unknown> = {}) =>
    ({
      key: { name: "pay", scopeKey: "s", token: 1 },
      options: { target: "gateway", operation: "pay", timeout: 5000 },
      frame: { execution: { lease } },
      answer,
      parts: { owners: new Set<string>() },
    }) as never;

  it("a cancel the tree's lease is told of when the frame has a lease that listens; any error is thrown as it is", async () => {
    const found = vi.fn();
    const error = cancel();

    await expect(cancelledBy(runWith({ cancelFound: found }))(error)).rejects.toBe(error);
    expect(found).toHaveBeenCalledExactlyOnceWith(error);
    await expect(cancelledBy(runWith(undefined))(error)).rejects.toBe(error);
    await expect(cancelledBy(runWith({}))(error)).rejects.toBe(error);

    const other = new Error("a store failed");
    const untold = vi.fn();
    await expect(cancelledBy(runWith({ cancelFound: untold }))(other)).rejects.toBe(other);
    expect(untold).not.toHaveBeenCalled();
  });

  it("an attempt is owned while it runs and kept open until its late answer settled; a lease that does not keep, or none, is no matter", async () => {
    const run = runWith({ keepWhile: vi.fn() }, { lateTail: undefined });
    const keepWhile = (run as unknown as { frame: { execution: { lease: { keepWhile: Mock } } } })
      .frame.execution.lease.keepWhile;
    let late: () => void = () => undefined;
    (run as unknown as { answer: { lateTail: Promise<void> } }).answer.lateTail = new Promise<void>(
      (resolve) => {
        late = resolve;
      },
    );

    const result = await owning(run, "owner-1", () => Promise.resolve("sent"));

    expect(result).toBe("sent");
    const [tracked, timeout] = keepWhile.mock.calls[0] as [Promise<unknown>, number];
    expect(timeout).toBe(5000);
    let isSettled = false;
    void tracked.then(() => {
      isSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(isSettled).toBe(false);
    late();
    await tracked;
    expect(isSettled).toBe(true);

    await expect(owning(runWith(undefined), "owner-2", () => Promise.resolve(1))).resolves.toBe(1);
    await expect(owning(runWith({}), "owner-3", () => Promise.resolve(2))).resolves.toBe(2);
  });

  it("a failed attempt waits for its late answer too, and its error is thrown", async () => {
    const keepWhile = vi.fn();
    const run = runWith({ keepWhile }, {});
    let late: () => void = () => undefined;
    (run as unknown as { answer: { lateTail: Promise<void> } }).answer.lateTail = new Promise<void>(
      (resolve) => {
        late = resolve;
      },
    );

    await expect(owning(run, "o", () => Promise.reject(new Error("the send failed")))).rejects.toThrow(
      "the send failed",
    );

    const [tracked] = keepWhile.mock.calls[0] as [Promise<unknown>];
    let isSettled = false;
    void tracked.then(() => {
      isSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(isSettled).toBe(false);
    late();
    await tracked;
    expect(isSettled).toBe(true);
  });

  it.each([
    [undefined, false],
    [false, false],
    [true, true],
  ])("an owner whose attempt is late (%s) stays owner: %s", async (isLate, stays) => {
    const run = runWith(undefined, isLate === undefined ? {} : { isLate });
    const { owners } = (run as unknown as { parts: { owners: Set<string> } }).parts;

    await owning(run, "owner-1", () => {
      expect(owners.has("owner-1")).toBe(true);
      return Promise.resolve(1);
    });

    expect(owners.has("owner-1")).toBe(stays);
  });
});

describe("#825: a call's key and the fingerprint it carries", () => {
  const keyOf = (changes: Record<string, unknown> = {}) =>
    effectKeyForTesting(
      {
        scopeKey: "s",
        tenantId: "t",
        leaseExecutionId: "e",
        token: 1,
        idempotencyKey: "e:pay:1",
        name: "pay",
        businessKey: "digest",
        ...changes,
      } as never,
      {},
    );

  it("a business key with no fingerprint takes its request's; one that has one is returned as it is", async () => {
    const frame = testFrame();
    const bare = keyOf();
    const said = keyOf({ fingerprint: "said" });

    const made = await runInFrame(
      { ...frame, execution: { ...frame.execution, fingerprintKeys: { current: TEST_IDEMPOTENCY_KEY } } },
      () => Promise.resolve(keyedByRequest(bare, { amount: 1 })),
    );

    expect(keyedByRequest(said, { amount: 1 })).toBe(said);
    expect(keyedByRequest(keyOf({ businessKey: undefined }), { amount: 1 })).toMatchObject({
      businessKey: undefined,
    });
    expect(made).not.toBe(bare);
    expect(made.fingerprint).toEqual(expect.any(String));
  });

  it("an intent superseded names its attempt and the attempt that did, in its details", () => {
    const base = {
      call: "pay",
      target: "gateway",
      operation: "pay",
      idempotencyKey: "e:pay:1",
      attempt: 1,
    };

    const known = supersededError({ ...base, supersededBy: 2 });
    const unknown = supersededError({ ...base, supersededBy: undefined });

    expect(known.details).toMatchObject({ attempt: 1, supersededBy: 2 });
    expect(unknown.details).toMatchObject({ attempt: 1 });
    expect(Object.keys(unknown.details ?? {})).not.toContain("supersededBy");
  });
});

describe("#1317: the window a replay trusts, against the call's timeout and ttl", () => {
  const callWith = (recovery: unknown, changes: Record<string, unknown> = {}) =>
    sendOnceOf({ recovery, ...changes });

  it("a window equal to the ttl is kept; one above it is refused, saying both; one at the timeout is refused", async () => {
    const atTtl = await callWith(OutboundRecovery.replayWithin(hours(48) as never));
    const aboveTtl = await callWith(OutboundRecovery.replayWithin((hours(48) + 1) as never));
    const atTimeout = await callWith(OutboundRecovery.replayWithin(seconds(5) as never));

    expect((atTtl as Error).message).toMatch(/^Idempotency read .* outside an execution\./);
    expect((aboveTtl as Error).message).toContain(
      `the call's ttl (172800000 ms) is below the key window (172800001 ms)`,
    );
    expect((atTimeout as Error).message).toContain(
      "the key window (5000 ms) is not above the call's timeout (5000 ms)",
    );
  });

  it.each([[0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    "a window of %s is no positive, finite duration",
    async (window) => {
      const error = await callWith(OutboundRecovery.replayWithin(window as never));

      expect((error as Error).message).toContain(
        `the key window is ${String(window)}, not a positive, finite duration`,
      );
    },
  );

  it("a window against a ttl that is Ttl.Forever is never above it", async () => {
    const error = await callWith(OutboundRecovery.replayWithin(hours(72) as never), {
      ttl: Ttl.Forever,
    });

    expect((error as Error).message).toMatch(/^Idempotency read .* outside an execution\./);
  });
});

describe("#1317: an Idempotency needs its logger and its clock", () => {
  const frame = outboundFrame();
  const build = (logger: unknown, clock: unknown) =>
    new Idempotency(
      frame.effects,
      frame.store,
      { requiresMask: false } as never,
      logger as never,
      clock as never,
    );

  it.each([
    ["no logger", undefined, {}],
    ["a logger that is null", null, {}],
    ["a logger that is a text", "log", {}],
    ["no clock", {}, undefined],
    ["a clock that is null", {}, null],
    ["a clock that is a function", {}, () => undefined],
  ])("%s is refused", (_why, logger, clock) => {
    expect(() => build(logger, clock)).toThrow(
      new TypeError("new Idempotency(…): a Logger and a Clock are required"),
    );
  });

  it("an object each is taken", () => {
    expect(() => build({}, {})).not.toThrow();
  });
});

describe("#1317: the service outside an application", () => {
  it("every call is refused, saying where an idempotent effect runs", async () => {
    const run = await rejectionOf(IDEMPOTENCY_OUTSIDE_APPLICATION.runOnce());
    const send = await rejectionOf(IDEMPOTENCY_OUTSIDE_APPLICATION.sendOnce());

    expect(run).toEqual(
      new TypeError(
        "Idempotency.runOnce: an idempotent effect runs in an application (createApp, testWith, a unit runner) — its store is the application's infrastructure",
      ),
    );
    expect(send).toEqual(
      new TypeError(
        "Idempotency.sendOnce: a call that leaves the system runs in an application (createApp, testWith, a unit runner) — its store is the application's infrastructure",
      ),
    );
    expect(Object.isFrozen(IDEMPOTENCY_OUTSIDE_APPLICATION)).toBe(true);
  });
});
