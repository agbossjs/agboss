/**
 * #1343 (#1313), end to end: `onCircuitStateChange` reaches an `@Observer` listed in the
 * application when a model provider's breaker — the instance's own, the one its model calls go
 * through — opens and closes. An event of the application, not an execution's: an observer filtered
 * by `workflows` does not hear it; the event holds the provider's name and the two states only.
 */
import { beforeEach, describe, expect } from "vitest";
import { Observer, type CircuitStateChangeEvent } from "../../../src/index.js";
import { RateLimitRepository } from "../../../src/infrastructure/rate-limit.repository.js";
import { providerCallsOf } from "../../../src/models/calls/provider-calls.js";
import { CircuitBreakerPolicy } from "../../../src/models/circuit-breaker-policy.js";
import { testWith } from "../../../src/testing/index.js";
import { minutes, seconds } from "../../../src/units/index.js";
import { applicationWith, workflowWith } from "./fixture.js";

const heard: CircuitStateChangeEvent[] = [];
const filtered: CircuitStateChangeEvent[] = [];

@Observer()
class BreakerWatch {
  onCircuitStateChange(event: CircuitStateChangeEvent): void {
    heard.push(event);
  }
}

@Observer({ workflows: [workflowWith("breaker-workflow")] })
class FilteredBreakerWatch {
  onCircuitStateChange(event: CircuitStateChangeEvent): void {
    filtered.push(event);
  }
}

const test = testWith(applicationWith("breaker-workflow", [BreakerWatch, FilteredBreakerWatch]));

const policy = CircuitBreakerPolicy.fixed({
  failureThreshold: 2,
  failureWindow: minutes(1),
  openDuration: seconds(30),
});

beforeEach(() => {
  heard.length = 0;
  filtered.length = 0;
});

describe("#1343: onCircuitStateChange, from the instance's breaker to the observer", () => {
  test("it opens at the threshold and closes after a good probe: both told, with the clock's time", async ({
    app,
    clock,
  }) => {
    await app.ready();
    const calls = providerCallsOf(app.resolve(RateLimitRepository), clock);
    const breaker = calls.breakerOf("fast-provider", policy);

    await breaker.recordFailure();
    expect(heard).toEqual([]);
    await breaker.recordFailure();
    const openedAt = clock.now();
    await clock.advance(seconds(31));
    expect(await breaker.admit()).toBe("probe");
    await breaker.recordSuccess();

    await expect.poll(() => heard.length).toBe(2);
    expect(heard[0]).toEqual({
      provider: "fast-provider",
      from: "closed",
      to: "open",
      at: openedAt,
    });
    expect(heard[1]).toMatchObject({ provider: "fast-provider", from: "half-open", to: "closed" });
    expect(Object.keys(heard[0] ?? {}).sort()).toEqual(["at", "from", "provider", "to"]);
  });

  test("an observer filtered by workflows does not hear the application's event", async ({
    app,
    clock,
  }) => {
    await app.ready();
    const breaker = providerCallsOf(app.resolve(RateLimitRepository), clock).breakerOf(
      "filtered-provider",
      policy,
    );

    await breaker.recordFailure();
    await breaker.recordFailure();

    await expect.poll(() => heard.length).toBe(1);
    expect(filtered).toEqual([]);
  });
});
