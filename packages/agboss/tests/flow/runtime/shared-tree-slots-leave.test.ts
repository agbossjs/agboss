/**
 * #1366: a step that left the queue while its leases were being taken — a cancel in the middle of the store's
 * answer — gives every lease back: the tree's slot is not held for the minute of its lease, and another instance
 * takes it at once; and the steps of one execution share its slot, held until the last of them is released. Run against
 * the in-memory store and SQLite, one clock.
 */
import { describe, expect, it } from "vitest";
import type { SlotClaim } from "../../../src/flow/runtime/launch/launch-registry.js";
import { SharedTreeSlots } from "../../../src/flow/runtime/launch/shared-tree-slots.js";
import type { RateLimitRepository } from "../../../src/index.js";
import { InMemoryRateLimitRepository } from "../../../src/infrastructure/rate-limit.repository.js";
import { SqliteRateLimitRepository } from "../../../src/infrastructure/sqlite/sqlite-rate-limit.repository.js";
import { withTarget } from "../../../src/testing/contracts/instance-context.js";
import { seconds } from "../../../src/units/index.js";
import { storeTargets } from "../../infrastructure/contracts/store-kinds.js";

const kinds = storeTargets<RateLimitRepository>(
  ({ clock, application, database }) =>
    new InMemoryRateLimitRepository(clock, application, database),
  ({ clock, application, connection }) =>
    new SqliteRateLimitRepository(connection(), clock, application),
);

const claimOf = (executionId: string): SlotClaim => ({
  executionId,
  depth: 2,
  closesBranch: false,
  subtrees: [],
});

/** The repository, its `acquire` followed by `then` (a cancel arriving with the store's answer). */
function afterAcquire(inner: RateLimitRepository, then: () => void): RateLimitRepository {
  return new Proxy(inner, {
    get: (target, key) => {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      const method = value as (...args: unknown[]) => Promise<unknown>;
      if (key !== "acquire") return method.bind(target);
      return async (...args: unknown[]) => {
        const lease = await method.apply(target, args);
        then();
        return lease;
      };
    },
  });
}

describe.each(kinds)("#1366: a step that leaves while its slot is taken ($name)", (target) => {
  it(
    "gives the slot back at once",
    withTarget(target, async ({ clock, first, second }) => {
      const cancel = new AbortController();
      const here = new SharedTreeSlots(
        {
          rateLimits: afterAcquire(first, () => {
            cancel.abort();
          }),
          clock,
          tenantId: "acme",
        },
        "root-1",
        1,
      );

      const left = await here.take(claimOf("a"), cancel.signal);
      await clock.advance(seconds(1));
      const elsewhere = await second.acquire("tree:acme:root-1", 1, seconds(30));

      expect(left).toBeUndefined();
      expect(elsewhere).toBeDefined();
    }),
  );
});

describe.each(kinds)("#1366: the steps that share one execution's slot ($name)", (target) => {
  it(
    "hold it until the last of them is released, then give it back",
    withTarget(target, async ({ clock, first, second }) => {
      const here = new SharedTreeSlots({ rateLimits: first, clock, tenantId: "acme" }, "root-1", 1);
      const open = new AbortController().signal;
      const one = await here.take(claimOf("a"), open);
      const two = await here.take(claimOf("a"), open);

      one?.release();
      const whileOneRuns = await second.acquire("tree:acme:root-1", 1, seconds(30));
      two?.release();
      const afterBoth = await second.acquire("tree:acme:root-1", 1, seconds(30));

      expect(whileOneRuns).toBeUndefined();
      expect(afterBoth).toBeDefined();
    }),
  );
});
