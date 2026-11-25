import { expect } from "vitest";
import type {
  ExecutionLease,
  ExecutionLeaseRepository,
} from "../../infrastructure/execution-lease.repository.js";
import { InterruptMode } from "../../app/interrupt-types.js";
import { StatusTrigger, ThreadStatus } from "../../turns/index.js";
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

const stopping = {
  tenantId: "default",
  threadId: "thread-1",
  toStatus: ThreadStatus.Stopping,
  trigger: StatusTrigger.Stop,
};

/**
 * The stop mark of a tree (#1341b, `requestStop` / `stopOf`): durable once it resolves, idempotent
 * and permanent like the cancel mark (no release, retire, take or takeover lifts it), carrying the
 * `InterruptMode` — which only ever escalates, `AfterStep` to `Immediate`, never back — and no
 * lease operation: the holder keeps its lease, renews it and releases it. It lives on the tree's own
 * lease row beside the cancel mark and is independent of it (`Cancel > Stop` is the caller's order:
 * both are readable). What an `Immediate` stop fences is the fencing stores' contract. A store
 * with a status history writes the transition in the mark's own transaction, only when this call
 * set or escalated the mark.
 */
export const LEASE_STOP_CASES: readonly ContractCase<ExecutionLeaseRepository>[] = [
  {
    name: "#1341b: stopOf is undefined for a tree never stopped, another tree or another tenant's, and the mode from either instance once requestStop resolved",
    run: async ({ first, second }: Instances): Promise<void> => {
      expect(await first.stopOf(TREE)).toBeUndefined();

      await second.requestStop(TREE, InterruptMode.AfterStep);

      expect(await first.stopOf(TREE)).toEqual({ mode: InterruptMode.AfterStep });
      expect(await second.stopOf(TREE)).toEqual({ mode: InterruptMode.AfterStep });
      expect(await first.stopOf({ ...TREE, rootExecutionId: "root-2" })).toBeUndefined();
      expect(await first.stopOf({ ...TREE, tenantId: "acme" })).toBeUndefined();
    },
  },
  {
    name: "#1341b: the mode only escalates — AfterStep becomes Immediate, Immediate stays when asked AfterStep again — and a repeat is idempotent",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.requestStop(TREE, InterruptMode.AfterStep);
      await second.requestStop(TREE, InterruptMode.AfterStep);
      expect(await first.stopOf(TREE)).toEqual({ mode: InterruptMode.AfterStep });

      await second.requestStop(TREE, InterruptMode.Immediate);
      await first.requestStop(TREE, InterruptMode.AfterStep);

      expect(await first.stopOf(TREE)).toEqual({ mode: InterruptMode.Immediate });
      expect(await second.stopOf(TREE)).toEqual({ mode: InterruptMode.Immediate });
    },
  },
  {
    name: "#1341b: requestStop changes no lease — the holder renews and releases it, the next take is token + 1, another instance is refused while it is held",
    run: async ({ first, second }: Instances): Promise<void> => {
      const held = await takenBy(first);

      await second.requestStop(TREE, InterruptMode.Immediate, stopping);

      expect(await first.renew(held, LEASE)).toBe(LEASE);
      expect(await second.acquire("default", "root-1", LEASE)).toBeUndefined();
      await first.release(held);
      expect(await second.acquire("default", "root-1", LEASE)).toMatchObject({ token: 2 });
    },
  },
  {
    name: "#1341b: a stop before the tree's first acquire is a seed row — the first take is token 1, no takeover, and the mark is there",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.requestStop(TREE, InterruptMode.AfterStep);

      const early = await second.acquire("default", "root-1", LEASE);

      expect(early).toMatchObject({ token: 1, holderInstanceId: "instance-2" });
      expect(early?.takenOverFrom).toBeUndefined();
      expect(await first.stopOf(TREE)).toEqual({ mode: InterruptMode.AfterStep });
    },
  },
  {
    name: "#1341b: the mark is permanent — it stays through every release, retire, take and takeover of the lease",
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      const held = await takenBy(first);
      await first.requestStop(TREE, InterruptMode.Immediate);
      const marked = async (): Promise<boolean> =>
        (await first.stopOf(TREE))?.mode === InterruptMode.Immediate &&
        (await second.stopOf(TREE))?.mode === InterruptMode.Immediate;

      await first.release(held);
      expect(await marked()).toBe(true);
      const next = await second.acquire("default", "root-1", LEASE);
      await clock.advance(seconds(31));
      const taken = await first.acquire("default", "root-1", LEASE);
      expect(await marked()).toBe(true);
      if (next === undefined || taken === undefined) throw new Error("both takes must succeed");
      await first.retire(taken);
      expect(await marked()).toBe(true);
    },
  },
  {
    name: "#1341b: a stop and a cancel are two marks on one row — each is read as it was set, whichever came first, and neither lifts the other",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.requestStop(TREE, InterruptMode.AfterStep);
      expect(await second.isCancelRequested(TREE)).toBe(false);

      await second.requestCancel(TREE);

      expect(await first.isCancelRequested(TREE)).toBe(true);
      expect(await first.stopOf(TREE)).toEqual({ mode: InterruptMode.AfterStep });
      await first.requestStop(TREE, InterruptMode.Immediate);
      expect(await second.isCancelRequested(TREE)).toBe(true);
    },
  },
  {
    name: "#1341b: markedOf answers both marks of the tree's row in one read — neither, the cancel's, the stop's with its mode, or both — the same as isCancelRequested and stopOf",
    run: async ({ first, second }: Instances): Promise<void> => {
      expect(await first.markedOf(TREE)).toEqual({ isCancelRequested: false });

      await second.requestStop(TREE, InterruptMode.AfterStep);
      expect(await first.markedOf(TREE)).toEqual({
        isCancelRequested: false,
        stop: { mode: InterruptMode.AfterStep },
      });

      await second.requestCancel(TREE);
      await second.requestStop(TREE, InterruptMode.Immediate);
      expect(await first.markedOf(TREE)).toEqual({
        isCancelRequested: true,
        stop: { mode: InterruptMode.Immediate },
      });
      expect(await first.markedOf({ ...TREE, rootExecutionId: "root-2" })).toEqual({
        isCancelRequested: false,
      });
    },
  },
];
