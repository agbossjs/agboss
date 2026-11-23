/**
 * #1366: what a held pass does with its room — renews its slot every 20 s until it is released or a renewal fails,
 * and releases it once: the lease back to the repository, the tenant and the real tokens to the gate, once
 * however many times it is released. An attempt releases its pass with none when it threw or failed, and hands
 * a good answer's release to the carrier, which gives the answer's own tokens when it is used up.
 */
import { describe, expect, it } from "vitest";
import {
  attemptOnce,
  type Attempt,
  type AttemptCarrier,
} from "../../src/models/calls/model-call.js";
import { heldPass, type GatePass } from "../../src/models/calls/gate-pass.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";

const LEASE = { key: "k", slotId: "s", holderInstanceId: "i", expiresAt: new Date(0) } as never;

function partsOf(renewals: boolean[] = []) {
  const clock = new VirtualClock();
  const events: string[] = [];
  const parts = {
    clock,
    rateLimits: {
      renew: () => {
        events.push("renew");
        return Promise.resolve(renewals.shift() ?? true);
      },
      release: () => {
        events.push("release");
        return Promise.resolve();
      },
    },
    onRelease: (release: { tenantId: string; tokens: number }) => {
      events.push(`told ${release.tenantId} ${String(release.tokens)}`);
      return Promise.resolve();
    },
  };
  return { clock, events, parts: parts as never };
}

describe("#1366: a held pass", () => {
  it("releases its lease, then tells the gate the tenant and the tokens, once however often it is released", async () => {
    const { events, parts } = partsOf();
    const pass = heldPass(parts, LEASE, "acme");

    await pass.release(42);
    await pass.release(7);

    expect(events).toEqual(["release", "told acme 42"]);
  });

  it("holds no lease without maxConcurrentCalls, and still tells the gate", async () => {
    const { events, parts } = partsOf();

    await heldPass(parts, undefined, "acme").release(5);

    expect(events).toEqual(["told acme 5"]);
  });

  it("renews its lease every 20 s while it is held, and no more once it is released", async () => {
    const { clock, events, parts } = partsOf();
    const pass = heldPass(parts, LEASE, "acme");

    await clock.advance(seconds(20));
    await clock.advance(seconds(20));
    expect(events).toEqual(["renew", "renew"]);
    await pass.release(0);
    await clock.advance(seconds(60));

    expect(events).toEqual(["renew", "renew", "release", "told acme 0"]);
  });

  it("stops renewing when a renewal is refused: the lease then expires by itself", async () => {
    const { clock, events, parts } = partsOf([true, false]);
    heldPass(parts, LEASE, "acme");

    for (let tick = 0; tick < 5; tick++) await clock.advance(seconds(20));

    expect(events).toEqual(["renew", "renew"]);
  });
});

/** An attempt that ended as `ended`, over a gate whose pass notes how it was released. */
async function attempt(ended: Attempt<string> | Error) {
  const released: number[] = [];
  const pass: GatePass = {
    release: (tokens) => {
      released.push(tokens);
      return Promise.resolve();
    },
  };
  const held: string[] = [];
  const carrier: AttemptCarrier<string> = {
    send: () => (ended instanceof Error ? Promise.reject(ended) : Promise.resolve(ended)),
    hold: (answer, release) => {
      held.push(answer);
      void release(11);
      return `held ${answer}`;
    },
    drop: () => Promise.resolve(),
  };
  const gate = { enter: () => Promise.resolve(pass) } as never;
  const limits = { gate, timeout: seconds(5), clock: new VirtualClock() };
  const result = await attemptOnce(carrier, limits, undefined).catch((error: unknown) => error);
  return { result, released, held };
}

describe("#1366: the pass of an attempt", () => {
  it("a good answer is held by the carrier, which releases its room with the answer's own tokens", async () => {
    const { result, released, held } = await attempt({ kind: "answered", answer: "ok" });

    expect(result).toMatchObject({ kind: "answered", answer: "held ok" });
    expect(held).toEqual(["ok"]);
    expect(released).toEqual([11]);
  });

  it("an answer that means a failure is released with no tokens and handed back as it is", async () => {
    const { result, released, held } = await attempt({
      kind: "answered",
      answer: "bad",
      failure: "server-error" as never,
    });

    expect(result).toMatchObject({ kind: "answered", answer: "bad" });
    expect(held).toEqual([]);
    expect(released).toEqual([0]);
  });

  it("a thrown attempt is released with no tokens", async () => {
    const { result, released } = await attempt({ kind: "threw", error: new Error("down") });

    expect(result).toMatchObject({ kind: "threw" });
    expect(released).toEqual([0]);
  });

  it("an attempt that rejects releases its pass before it rejects", async () => {
    const { result, released } = await attempt(new Error("the caller left"));

    expect(result).toMatchObject({ message: "the caller left" });
    expect(released).toEqual([0]);
  });
});
