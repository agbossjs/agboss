/**
 * #262 AC12 (PR 1): the virtual clock. Every framework time read and wait goes through the
 * application's one `Clock` — a test's `VirtualClock` (the `clock` fixture) moves deadlines, 429
 * pauses, backoff and leases with `clock.advance(…)`, without real waiting; an application may list
 * its own `Clock`, which production uses. The gate rule itself: tests/lint/no-direct-time.test.ts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { AppOptions } from "../../src/app/create-app.js";
import { applicationOf } from "../../src/application/assemble.js";
import { createApp } from "../../src/application/create-app.js";
import { GraphRuleError } from "../../src/index.js";
import { ModelFailure, RetryPolicy } from "../../src/models/index.js";
import { resilientFetch } from "../../src/models/resilient-fetch.js";
import { callTool, replyWith, testWith, VirtualClock } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { ToolTimeoutError } from "../../src/tools/index.js";
import { minutes, seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { completion, providerStub, type StubReply } from "../models/stub.js";
import {
  ClockApplication,
  ClockClerk,
  ClockInWorkflowApplication,
  ClockWorkflowStart,
  ContextClockApplication,
  FIXED_MOMENT,
  FixedClockApplication,
  FixedClockProvider,
  hooks,
  ReceiptDto,
  resetClock,
  seen,
  SlowLookup,
  Stamp,
} from "./fixtures/clock.workflow.js";

const TEST_START = "2026-01-05T09:00:00.000Z";

beforeEach(resetClock);

describe("#262 AC12: the VirtualClock", () => {
  it("wakes the due sleeps in time order, takes durations with units, ends a sleep on abort", async () => {
    const clock = new VirtualClock();
    const woken: string[] = [];
    const stopped = new AbortController();
    const late = clock.sleep(seconds(20)).then(() => woken.push("late"));
    const early = clock.sleep(seconds(5)).then(() => woken.push("early"));
    const never = clock.sleep(seconds(60), stopped.signal).then(() => woken.push("aborted"));

    await clock.advance("30s");
    stopped.abort();
    await Promise.all([late, early, never]);

    expect(woken).toEqual(["early", "late", "aborted"]);
    expect(clock.now().toISOString()).toBe("2026-01-05T09:00:30.000Z");
    await clock.sleep(seconds(1), stopped.signal);
  });

  it("two timers due in one advance: each one's work runs before the next wakes", async () => {
    const clock = new VirtualClock(new Date("2026-03-01T00:00:00.000Z"));
    const order: string[] = [];
    const first = clock.sleep(seconds(10)).then(async () => {
      order.push("first");
      await Promise.resolve();
      order.push("first's work");
    });
    const second = clock.sleep(seconds(10)).then(() => order.push("second"));
    const third = clock.sleep(seconds(3)).then(() => order.push("third"));

    await clock.advance(minutes(1));
    await Promise.all([first, second, third]);

    expect(order).toEqual(["third", "first", "first's work", "second"]);
  });

  it("a sleep is due only once its whole delay has passed", async () => {
    const clock = new VirtualClock();
    let woken = false;
    const sleeping = clock.sleep(seconds(10)).then(() => {
      woken = true;
    });

    await clock.advance(seconds(9));
    const before = woken;
    await clock.advance(seconds(1));
    await sleeping;

    expect([before, woken]).toEqual([false, true]);
  });
});

const test = testWith(ClockApplication);

describe("#262 AC12: the clock fixture is the application's Clock", () => {
  test("the fixture, app.clock, an injected Clock and the instance's start are one clock", async ({
    app,
    clock,
  }) => {
    await app.ready();

    const [started] = seen.starts;
    expect(clock).toBeInstanceOf(VirtualClock);
    expect(app.clock).toBe(clock);
    expect(started?.clock).toBe(clock);
    expect(started?.startedAt.toISOString()).toBe(TEST_START);
  });

  test("clock.advance moves what a component reads", async ({ app, clock, mockLlm }) => {
    mockLlm(ClockClerk).thenReturn(
      callTool(Stamp, { text: "now" }),
      replyWith(ReceiptDto, { text: "Stamped." }),
    );

    await clock.advance("25h");
    await execute(app, ClockWorkflowStart, { text: "stamp" });

    expect(seen.stamps).toEqual(["2026-01-06T10:00:00.000Z"]);
  });

  test("a tool's timeout runs on the clock: it fires on advance, never by real waiting", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(ClockClerk).thenReturn(
      callTool(SlowLookup, { text: "acme" }),
      replyWith(ReceiptDto, { text: "The lookup timed out." }),
    );
    const started = new Promise<void>((resolve) => {
      hooks.lookupStarted = resolve;
    });
    const call = execute(app, ClockWorkflowStart, { text: "look acme up" });
    await started;

    await clock.advance(seconds(4));
    const before = seen.lookups[0]?.aborted;
    await clock.advance(seconds(1));
    const result = await call;

    expect(before).toBe(false);
    expect(seen.lookups[0]?.reason).toBeInstanceOf(ToolTimeoutError);
    expect(result.output).toEqual({ text: "The lookup timed out." });
  });
});

describe("#262: a Clock the application lists", () => {
  it("is the clock of every part outside tests: the start, the components", async () => {
    const app = await createApp(FixedClockApplication, {
      processEnv: {},
      gateway: createScriptedGateway(new ScriptBook()),
    });
    await app.close();

    const [started] = seen.starts;
    expect(started?.clock).toBeInstanceOf(FixedClockProvider);
    expect(started?.startedAt.toISOString()).toBe(FIXED_MOMENT);
  });

  it("is the one way to set the clock: createApp takes no clock option", () => {
    const options: AppOptions = {
      // @ts-expect-error — the clock is infrastructure, listed in @Application({ providers })
      clock: new FixedClockProvider(),
    };

    expect(options).toBeDefined();
  });

  testWith(FixedClockApplication)(
    "is replaced by the VirtualClock in tests: the test controls the time",
    async ({ app, clock }) => {
      await app.ready();

      expect(seen.starts[0]?.clock).toBe(clock);
    },
  );

  it("may not depend on the application's contexts: they read their start from it", async () => {
    const starting = createApp(ContextClockApplication, {
      processEnv: {},
      gateway: createScriptedGateway(new ScriptBook()),
    });

    await expect(starting).rejects.toThrow(
      "ContextClockProvider cannot depend on the application's contexts: the Clock is created before them",
    );
  });

  it("is infrastructure: in a workflow's providers it is di.infrastructure-in-workflow", async () => {
    const error: unknown = await applicationOf(ClockInWorkflowApplication).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(GraphRuleError);
    expect(String(error)).toContain(
      "[di.infrastructure-in-workflow] FixedClockProvider extends Clock",
    );
  });
});

/** A provider's client on the clock, over a stub (`timeout` 5 s, two attempts on a 429, waits ≤ 10 s). */
function clientOn(clock: VirtualClock, replies: readonly StubReply[]) {
  const stub = providerStub(replies);
  const send = resilientFetch(
    {
      provider: "p",
      baseUrl: "http://p.test",
      timeout: seconds(5),
      retryPolicy: RetryPolicy.exponential({
        maxAttempts: 2,
        initialDelay: seconds(1),
        maxDelay: seconds(10),
        jitter: false,
        retryOn: [ModelFailure.RateLimited],
      }),
      clock,
    },
    stub.fetch,
  );
  return { stub, send: () => send("http://p.test/chat/completions") };
}

describe("#262 AC12: a model call's waits run on the clock", () => {
  it("a 429's Retry-After pause ends on advance, not by real waiting", async () => {
    const clock = new VirtualClock();
    const { stub, send } = clientOn(clock, [
      { status: 429, headers: { "retry-after": "7" } },
      completion(),
    ]);
    const call = send();

    await clock.advance(seconds(6));
    const before = stub.requests.length;
    await clock.advance(seconds(1));

    expect((await call).status).toBe(200);
    expect([before, stub.requests.length]).toEqual([1, 2]);
  });

  it("a request that gets no answer fails at its timeout on the clock", async () => {
    const clock = new VirtualClock();
    const neverAnswers: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason as Error);
        });
      });
    const send = resilientFetch(
      {
        provider: "p",
        baseUrl: "http://p.test",
        timeout: seconds(5),
        retryPolicy: RetryPolicy.none(),
        clock,
      },
      neverAnswers,
    );
    const call = send("http://p.test/chat/completions");
    call.catch(() => undefined);

    await clock.advance(seconds(5));

    await expect(call).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
