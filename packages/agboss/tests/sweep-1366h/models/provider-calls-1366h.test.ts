/**
 * #1366: the calls of one instance are shared: the same repository gives the same ProviderCalls, one provider the
 * same gate every time (its queue and level are per instance, not per request), another provider another gate,
 * and without a rate-limit policy there is no gate.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { providerCallsOf, ProviderCalls } from "../../../src/models/calls/provider-calls.js";
import { RateLimitPolicy } from "../../../src/models/index.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { instanceCalls } from "../../models/gateway.js";

describe("#1366: what an instance shares of its model calls", () => {
  it("one gate per provider, the same one each time", () => {
    const calls = instanceCalls();
    const policy = RateLimitPolicy.of({ maxConcurrentCalls: 2 });

    const first = calls.gateOf("provider-a", policy);
    const again = calls.gateOf("provider-a", policy);
    const other = calls.gateOf("provider-b", policy);

    expect(first).toBeDefined();
    expect(again).toBe(first);
    expect(other).toBeDefined();
    expect(other).not.toBe(first);
    expect(calls.gateOf("provider-a", undefined)).toBeUndefined();
  });

  it("one ProviderCalls per repository, whoever asks", () => {
    const clock = new VirtualClock();
    const calls = instanceCalls(clock, new InMemoryDatabase());
    const same = providerCallsOf(calls.rateLimits, clock);
    const again = providerCallsOf(calls.rateLimits, clock);
    const elsewhere = instanceCalls(clock, new InMemoryDatabase());

    expect(same).toBeInstanceOf(ProviderCalls);
    expect(again).toBe(same);
    expect(providerCallsOf(elsewhere.rateLimits, clock)).not.toBe(same);
  });
});
