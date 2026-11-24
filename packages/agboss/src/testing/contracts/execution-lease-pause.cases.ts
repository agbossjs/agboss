import { expect } from "vitest";
import type {
  ExecutionLease,
  ExecutionLeaseRepository,
} from "../../infrastructure/execution-lease.repository.js";
import { InterruptMode } from "../../app/interrupt-types.js";
import { seconds } from "../../units/index.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";

/** What each case below gets. */
type Instances = ContractInstances<ExecutionLeaseRepository>;

const LEASE = seconds(30);

/** The tree of the cases: `root-1` of the default tenant. */
const TREE = { tenantId: "default", rootExecutionId: "root-1" } as const;

async function takenBy(store: ExecutionLeaseRepository): Promise<ExecutionLease> {
  const held = await store.acquire("default", "root-1", LEASE);
  if (held === undefined) throw new Error("the first acquire of a free tree must take its lease");
  return held;
}

/**
 * The external pause of a tree (#1341c, `requestPause` / `unpause` / `pauseOf`): `isExternallyPaused`
 * and its reason on the tree's own lease row, durable once it resolves and idempotent — a repeat only
 * updates the reason —, changing no lease; and the fence an `Immediate` pause raises,
 * `fencedThroughToken = GREATEST(itself, the row's token)`: it only ever rises, `unpause` never lowers
 * it, a lease at a higher token (`release` then `acquire`, `reclaim`) is not fenced by it. What the fence
 * refuses is the fencing stores' contract (`fenced-effect-pause.cases.ts`).
 */
export const LEASE_PAUSE_CASES: readonly ContractCase<ExecutionLeaseRepository>[] = [
  {
    name: "#1341c: pauseOf is empty for a tree never paused; once requestPause resolved, both instances read the pause with its reason — an AfterStep pause raises no fence",
    run: async ({ first, second }: Instances): Promise<void> => {
      expect(await first.pauseOf(TREE)).toEqual({});

      await second.requestPause(TREE, { mode: InterruptMode.AfterStep, reason: "maintenance" });

      expect(await first.pauseOf(TREE)).toEqual({ pause: { reason: "maintenance" } });
      expect(await second.pauseOf(TREE)).toEqual({ pause: { reason: "maintenance" } });
      expect(await first.pauseOf({ ...TREE, rootExecutionId: "root-2" })).toEqual({});
      expect(await first.pauseOf({ ...TREE, tenantId: "acme" })).toEqual({});
    },
  },
  {
    name: "#1341c: an Immediate pause fences the row's current token — and the pause is no lease operation: the holder renews and releases, the next take is token + 1, above the fence",
    run: async ({ first, second }: Instances): Promise<void> => {
      const held = await takenBy(first);

      await second.requestPause(TREE, { mode: InterruptMode.Immediate });

      expect(await first.pauseOf(TREE)).toEqual({ pause: {}, fencedThroughToken: held.token });
      expect(await first.renew(held, LEASE)).toBe(LEASE);
      expect(await second.acquire("default", "root-1", LEASE)).toBeUndefined();
      await first.release(held);
      const next = await second.acquire("default", "root-1", LEASE);
      expect(next).toMatchObject({ token: held.token + 1 });
      expect((await second.pauseOf(TREE)).fencedThroughToken).toBe(held.token);
    },
  },
  {
    name: "#1341c: the fence only rises (GREATEST) — a later AfterStep pause, a repeat and an unpause never lower or clear it, and a higher token's Immediate pause raises it",
    run: async ({ first, second }: Instances): Promise<void> => {
      const held = await takenBy(first);
      await first.requestPause(TREE, { mode: InterruptMode.Immediate });
      await first.requestPause(TREE, { mode: InterruptMode.AfterStep });
      await second.unpause(TREE);

      expect((await first.pauseOf(TREE)).fencedThroughToken).toBe(held.token);
      expect((await first.pauseOf(TREE)).pause).toBeUndefined();

      await first.release(held);
      const next = await second.acquire("default", "root-1", LEASE);
      await second.requestPause(TREE, { mode: InterruptMode.Immediate });

      expect((await first.pauseOf(TREE)).fencedThroughToken).toBe(next?.token);
      expect(next?.token).toBe(held.token + 1);
    },
  },
  {
    name: "#1341c: a repeated requestPause only updates the reason, unpause clears the pause and its reason, and an unpause of a tree not paused is a no-op",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.unpause(TREE);
      expect(await first.pauseOf(TREE)).toEqual({});

      await first.requestPause(TREE, { mode: InterruptMode.AfterStep, reason: "one" });
      await second.requestPause(TREE, { mode: InterruptMode.AfterStep, reason: "two" });
      expect(await first.pauseOf(TREE)).toEqual({ pause: { reason: "two" } });

      await second.unpause(TREE);
      await first.unpause(TREE);
      expect(await first.pauseOf(TREE)).toEqual({});
    },
  },
  {
    name: "#1341c: a pause before the tree's first acquire is a seed row — the first take is token 1, no takeover, and an Immediate pause fences nothing of it",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.requestPause(TREE, { mode: InterruptMode.Immediate });

      const early = await second.acquire("default", "root-1", LEASE);

      expect(early).toMatchObject({ token: 1, holderInstanceId: "instance-2" });
      expect(early?.takenOverFrom).toBeUndefined();
      expect((await first.pauseOf(TREE)).fencedThroughToken).toBe(0);
    },
  },
  {
    name: "#1341c: markedOf carries the pause and the fence with the cancel and stop marks, in one read",
    run: async ({ first, second }: Instances): Promise<void> => {
      const held = await takenBy(first);
      await second.requestPause(TREE, { mode: InterruptMode.Immediate, reason: "freeze" });
      await second.requestCancel(TREE);

      expect(await first.markedOf(TREE)).toEqual({
        isCancelRequested: true,
        pause: { reason: "freeze" },
        fencedThroughToken: held.token,
      });
    },
  },
];
