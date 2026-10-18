/**
 * #265 AC1: `RateLimitRepository` is lease-based — at most `maxSlots` leases under one key across
 * instances; a slot taken by one instance is not given to the other; past its lease an abandoned
 * slot is free again; `ExecutionSlotRepository` does not exist (S27). One suite, run against the
 * in-memory default and `SqliteRateLimitRepository` (two instances on one file), one clock.
 */
import { describe, expect, it } from "vitest";
import * as agboss from "../../src/index.js";
import { InMemoryRateLimitRepository } from "../../src/infrastructure/rate-limit.repository.js";
import { SqliteRateLimitRepository } from "../../src/infrastructure/sqlite/sqlite-rate-limit.repository.js";
import type { RateLimitRepository } from "../../src/index.js";
import { seconds } from "../../src/units/index.js";
import { storeKinds } from "./contracts/store-kinds.js";

const kinds = storeKinds<RateLimitRepository>({
  inMemory: ({ clock, application, database }) =>
    new InMemoryRateLimitRepository(clock, application, database),
  sqlite: ({ clock, application, connection }) =>
    new SqliteRateLimitRepository(connection(), clock, application),
});

describe.each(kinds)(
  "#265 AC1: rate-limit slots are leases shared by the instances ($name)",
  ({ twoInstances }) => {
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

    it("a slot renewed exactly at its expiry is already free: renew answers false", async () => {
      const { clock, first, second } = twoInstances();
      const held = await first.acquire("openrouter", 1, seconds(30));

      await clock.advance(seconds(30));

      expect(held && (await first.renew(held, seconds(30)))).toBe(false);
      expect(await second.acquire("openrouter", 1, seconds(30))).toMatchObject({
        holderInstanceId: "instance-2",
      });
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
  },
);

describe.each(kinds)(
  "#266 S58 / #265 S52: windows and pauses are shared by the instances ($name)",
  ({ twoInstances }) => {
    it("a window counts across instances within its length, then forgets", async () => {
      const { clock, first, second } = twoInstances();

      expect(await first.addToWindow("p:calls", 1, seconds(60), 2)).toBe(1);
      expect(await second.addToWindow("p:calls", 1, seconds(60), 2)).toBe(2);
      expect(await second.addToWindow("p:calls", 1, seconds(60), 2)).toBeUndefined();
      expect(await first.addToWindow("p:calls", 0, seconds(60))).toBe(2);
      await clock.advance(seconds(60));

      expect(await first.addToWindow("p:calls", 1, seconds(60), 2)).toBe(1);
    });

    it("amounts add up; a cleared window starts from nothing; keys are apart", async () => {
      const { first, second } = twoInstances();
      await first.addToWindow("p:tokens", 1500, seconds(60));
      await second.addToWindow("p:tokens", 500, seconds(60));
      await second.addToWindow("q:tokens", 7, seconds(60));

      expect(await first.addToWindow("p:tokens", 0, seconds(60))).toBe(2000);
      await second.clearWindow("p:tokens");
      expect(await first.addToWindow("p:tokens", 0, seconds(60))).toBe(0);
      expect(await first.addToWindow("q:tokens", 0, seconds(60))).toBe(7);
    });

    it("a pause set by one instance holds on the other until it ends; a later one is kept", async () => {
      const { clock, first, second } = twoInstances();
      const start = clock.now().getTime();

      await first.pauseUntil("p:cooldown", new Date(start + 30_000));
      await second.pauseUntil("p:cooldown", new Date(start + 10_000));

      expect(await second.pausedUntil("p:cooldown")).toEqual(new Date(start + 30_000));
      expect(await second.pausedUntil("q:cooldown")).toBeUndefined();
      await clock.advance(seconds(30));
      expect(await first.pausedUntil("p:cooldown")).toBeUndefined();
    });
  },
);

describe("#265 AC1 (S27): the contracts", () => {
  it("ExecutionSlotRepository does not exist (S27); the three shared contracts do", () => {
    expect("ExecutionSlotRepository" in agboss).toBe(false);
    expect(agboss.RateLimitRepository).toBeTypeOf("function");
    expect(agboss.ExecutionTreeRepository).toBeTypeOf("function");
    expect(agboss.ExecutionLeaseRepository).toBeTypeOf("function");
  });
});
