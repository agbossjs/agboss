import { expect } from "vitest";
import type { RateLimitRepository } from "../../infrastructure/rate-limit.repository.js";
import { seconds } from "../../units/index.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./seam.js";

/** What each case below gets. */
type Instances = ContractInstances<RateLimitRepository>;

const MINUTE = seconds(60);

/** #266 S58 / #265 S52: a provider's per-minute windows and its 429 pause, shared by instances. */
export const RATE_WINDOW_CASES: readonly ContractCase<RateLimitRepository>[] = [
  {
    name: "a window counts across instances within its length, then forgets",
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      expect(await first.addToWindow("p:calls", 1, MINUTE, 2)).toBe(1);
      expect(await second.addToWindow("p:calls", 1, MINUTE, 2)).toBe(2);
      expect(await second.addToWindow("p:calls", 1, MINUTE, 2)).toBeUndefined();
      expect(await first.addToWindow("p:calls", 0, MINUTE)).toBe(2);
      await clock.advance(MINUTE);

      expect(await first.addToWindow("p:calls", 1, MINUTE, 2)).toBe(1);
    },
  },
  {
    name: "amounts add up; a cleared window starts from nothing; keys are apart",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.addToWindow("p:tokens", 1500, MINUTE);
      await second.addToWindow("p:tokens", 500, MINUTE);
      await second.addToWindow("q:tokens", 7, MINUTE);

      expect(await first.addToWindow("p:tokens", 0, MINUTE)).toBe(2000);
      await second.clearWindow("p:tokens");
      expect(await first.addToWindow("p:tokens", 0, MINUTE)).toBe(0);
      expect(await first.addToWindow("q:tokens", 0, MINUTE)).toBe(7);
    },
  },
  {
    name: "a pause set by one instance holds on the other until it ends; a later one is kept",
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      const start = clock.now().getTime();

      await first.pauseUntil("p:cooldown", new Date(start + 30_000));
      await second.pauseUntil("p:cooldown", new Date(start + 10_000));

      expect(await second.pausedUntil("p:cooldown")).toEqual(new Date(start + 30_000));
      expect(await second.pausedUntil("q:cooldown")).toBeUndefined();
      await clock.advance(seconds(30));
      expect(await first.pausedUntil("p:cooldown")).toBeUndefined();
    },
  },
];
