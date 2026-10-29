import { expect } from "vitest";
import type { RateLimitRepository } from "../../infrastructure/rate-limit.repository.js";
import { seconds } from "../../units/index.js";
import { pingOf, registerContract, type ContractCase } from "./define.js";
import { RATE_WINDOW_CASES } from "./rate-limit-window.cases.js";
import type { ContractTarget } from "./seam.js";

const LEASE = seconds(30);

const SLOT_CASES: readonly ContractCase<RateLimitRepository>[] = [
  {
    name: "a slot taken by one instance is not given to the other",
    run: async ({ first, second }) => {
      const taken = await first.acquire("openrouter", 1, LEASE);
      const refused = await second.acquire("openrouter", 1, LEASE);
      const otherKey = await second.acquire("decisions", 1, LEASE);

      expect(taken).toMatchObject({ key: "openrouter", holderInstanceId: "instance-1" });
      expect(refused).toBeUndefined();
      expect(otherKey).toMatchObject({ key: "decisions", holderInstanceId: "instance-2" });
    },
  },
  {
    name: "maxSlots slots under one key, then none until one is released",
    run: async ({ first, second }) => {
      const one = await first.acquire("openrouter", 2, LEASE);
      await second.acquire("openrouter", 2, LEASE);

      const third = await second.acquire("openrouter", 2, LEASE);
      if (one !== undefined) await first.release(one);
      const afterRelease = await second.acquire("openrouter", 2, LEASE);

      expect(third).toBeUndefined();
      expect(afterRelease).toMatchObject({ holderInstanceId: "instance-2" });
    },
  },
  {
    name: "after the lease an abandoned slot is free again; its old lease cannot be renewed",
    run: async ({ clock, first, second }) => {
      const abandoned = await first.acquire("openrouter", 1, LEASE);

      await clock.advance(seconds(31));
      const taken = await second.acquire("openrouter", 1, LEASE);

      expect(taken).toMatchObject({ holderInstanceId: "instance-2" });
      expect(abandoned && (await first.renew(abandoned, LEASE))).toBe(false);
    },
  },
  {
    name: "a slot renewed exactly at its expiry is already free: renew answers false",
    run: async ({ clock, first, second }) => {
      const held = await first.acquire("openrouter", 1, LEASE);

      await clock.advance(LEASE);

      expect(held && (await first.renew(held, LEASE))).toBe(false);
      expect(await second.acquire("openrouter", 1, LEASE)).toMatchObject({
        holderInstanceId: "instance-2",
      });
    },
  },
  {
    name: "a renewed slot outlives its first lease",
    run: async ({ clock, first, second }) => {
      const held = await first.acquire("openrouter", 1, LEASE);

      await clock.advance(seconds(20));
      const renewed = held && (await first.renew(held, LEASE));
      await clock.advance(seconds(20));

      expect(renewed).toBe(true);
      expect(await second.acquire("openrouter", 1, LEASE)).toBeUndefined();
    },
  },
];

/**
 * `RateLimitRepository` (#265 AC1, #266 S58): slots are leases — at most `maxSlots` under one key
 * across instances, an abandoned one free again past its lease; windows count across instances
 * within their length; a pause set by one instance holds on the other until it ends.
 */
export function rateLimitContract(target: ContractTarget<RateLimitRepository>): void {
  registerContract(
    "rate limit contract",
    target,
    [
      { title: "rate-limit slots are leases shared by the instances", cases: SLOT_CASES },
      { title: "windows and pauses are shared by the instances", cases: RATE_WINDOW_CASES },
    ],
    pingOf,
  );
}
