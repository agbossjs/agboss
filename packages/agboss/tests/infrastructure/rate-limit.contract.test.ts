/**
 * #265 AC1: `RateLimitRepository` is lease-based — at most `maxSlots` leases under one key across
 * instances; a slot taken by one instance is not given to the other; past its lease an abandoned
 * slot is free again; `ExecutionSlotRepository` does not exist (S27). The contract on the in-memory
 * default: two instances over one database and one clock.
 */
import { describe, expect, it } from "vitest";
import * as agboss from "../../src/index.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryRateLimitRepository } from "../../src/infrastructure/rate-limit.repository.js";
import { createTestClock, type VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";

function twoInstances(): {
  clock: VirtualClock;
  first: InMemoryRateLimitRepository;
  second: InMemoryRateLimitRepository;
} {
  const clock = createTestClock();
  const database = new InMemoryDatabase();
  return {
    clock,
    first: new InMemoryRateLimitRepository(clock.now, "instance-1", database),
    second: new InMemoryRateLimitRepository(clock.now, "instance-2", database),
  };
}

describe("#265 AC1: rate-limit slots are leases shared by the instances", () => {
  it("a slot taken by one instance is not given to the other", async () => {
    const { first, second } = twoInstances();

    const taken = await first.acquire("openrouter", 1, seconds(30));
    const refused = await second.acquire("openrouter", 1, seconds(30));
    const otherKey = await second.acquire("decisions", 1, seconds(30));

    expect(taken).toMatchObject({ key: "openrouter", holderInstanceId: "instance-1" });
    expect(refused).toBeUndefined();
    expect(otherKey).toMatchObject({ key: "decisions", holderInstanceId: "instance-2" });
  });

  it("maxSlots slots under one key, then none until one is released", async () => {
    const { first, second } = twoInstances();
    const one = await first.acquire("openrouter", 2, seconds(30));
    await second.acquire("openrouter", 2, seconds(30));

    const third = await second.acquire("openrouter", 2, seconds(30));
    if (one !== undefined) await first.release(one);
    const afterRelease = await second.acquire("openrouter", 2, seconds(30));

    expect(third).toBeUndefined();
    expect(afterRelease).toMatchObject({ holderInstanceId: "instance-2" });
  });

  it("after the lease an abandoned slot is free again; its old lease cannot be renewed", async () => {
    const { clock, first, second } = twoInstances();
    const abandoned = await first.acquire("openrouter", 1, seconds(30));

    await clock.advance(seconds(31));
    const taken = await second.acquire("openrouter", 1, seconds(30));

    expect(taken).toMatchObject({ holderInstanceId: "instance-2" });
    expect(abandoned && (await first.renew(abandoned, seconds(30)))).toBe(false);
  });

  it("a renewed slot outlives its first lease", async () => {
    const { clock, first, second } = twoInstances();
    const held = await first.acquire("openrouter", 1, seconds(30));

    await clock.advance(seconds(20));
    const renewed = held && (await first.renew(held, seconds(30)));
    await clock.advance(seconds(20));

    expect(renewed).toBe(true);
    expect(await second.acquire("openrouter", 1, seconds(30))).toBeUndefined();
  });

  it("ExecutionSlotRepository does not exist (S27); the three shared contracts do", () => {
    expect("ExecutionSlotRepository" in agboss).toBe(false);
    expect(agboss.RateLimitRepository).toBeTypeOf("function");
    expect(agboss.ExecutionTreeRepository).toBeTypeOf("function");
    expect(agboss.ExecutionLeaseRepository).toBeTypeOf("function");
  });
});
