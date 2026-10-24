/**
 * #333 PR 3 (S8) — the slots of a tree that can launch on any instance: its
 * `maxConcurrentExecutions` held as leases in the shared `RateLimitRepository`, one count over the
 * instances; a slot per execution (its steps share it), renewed while held, a child's own smaller
 * cap a second lease (both or none). Run against the in-memory store and SQLite (two instances on
 * one file), one clock.
 */
import { describe, expect, it } from "vitest";
import { SharedTreeSlots } from "../../../src/flow/runtime/launch/shared-tree-slots.js";
import {
  TreeSlotRegistry,
  TreeSlots,
  type SlotClaim,
  type SubtreeCap,
} from "../../../src/flow/runtime/launch/launch-registry.js";
import { treeLaunchesOnAnyInstance } from "../../../src/flow/analyse/child-placements.js";
import type { Class } from "../../../src/components/injection.js";
import { Workflow, WorkflowStart } from "../../../src/index.js";
import { start } from "../../helpers/flow.js";
import { ItemDto, SummaryDto } from "./fixtures/fan-out.workflow.js";
import { RemoteItemWorkflow } from "./fixtures/remote-children.workflow.js";
import {
  RemoteCappedWorkflow,
  RemoteSpendCheckedWorkflowFinish,
  RemoteSpendWorkflow,
} from "./fixtures/remote-limits.workflow.js";
import { RemoteCountdownWorkflow } from "./fixtures/remote-recursion.workflow.js";
import type { SlotHold } from "../../../src/flow/runtime/launch/slot-queue.js";
import type { RateLimitRepository } from "../../../src/index.js";
import { InMemoryRateLimitRepository } from "../../../src/infrastructure/rate-limit.repository.js";
import { SqliteRateLimitRepository } from "../../../src/infrastructure/sqlite/sqlite-rate-limit.repository.js";
import type { VirtualClock } from "../../../src/testing/clock.js";
import { minutes, seconds } from "../../../src/units/index.js";
import { storeKinds } from "../../infrastructure/contracts/store-kinds.js";

const kinds = storeKinds<RateLimitRepository>({
  inMemory: ({ clock, application, database }) =>
    new InMemoryRateLimitRepository(clock, application, database),
  sqlite: ({ clock, application, connection }) =>
    new SqliteRateLimitRepository(connection(), clock, application),
});

const claimOf = (executionId: string, subtrees: readonly SubtreeCap[] = []): SlotClaim => ({
  executionId,
  depth: 2,
  closesBranch: false,
  subtrees,
});

const open = new AbortController().signal;

/** A step waiting for a slot: what it got so far. */
interface Waiting {
  hold: SlotHold | undefined;
  readonly taken: Promise<SlotHold | undefined>;
}

const waitingFor = (taken: Promise<SlotHold | undefined>): Waiting => {
  const waiting: Waiting = { hold: undefined, taken };
  void taken.then((hold) => {
    waiting.hold = hold;
  });
  return waiting;
};

/** Lets the slots' own promises run (their store calls answer at once). */
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe.each(kinds)(
  "#333 PR 3: a tree's slots shared by the instances ($name)",
  ({ twoInstances }) => {
    const slotsOf = (rateLimits: RateLimitRepository, clock: VirtualClock, cap = 2) =>
      new SharedTreeSlots({ rateLimits, clock, tenantId: "acme" }, "root-1", cap);

    it("one cap over the instances: a third execution waits until a slot frees on either", async () => {
      const { clock, first, second } = twoInstances();
      const here = slotsOf(first, clock);
      const there = slotsOf(second, clock);
      await here.take(claimOf("a"), open);
      const b = await there.take(claimOf("b"), open);

      const c = waitingFor(here.take(claimOf("c"), open));
      await settled();
      const whileFull = c.hold;
      b?.release();
      await settled();
      const beforeLook = c.hold;
      await clock.advance(seconds(1));
      await c.taken;

      expect(whileFull).toBeUndefined();
      expect(beforeLook).toBeUndefined(); // freed on the other instance: seen at the next look
      expect(c.hold).toBeDefined();
    });

    it("a slot freed on this instance lets its next step in at once", async () => {
      const { clock, first } = twoInstances();
      const here = slotsOf(first, clock, 1);
      const a = await here.take(claimOf("a"), open);
      const b = waitingFor(here.take(claimOf("b"), open));
      await settled();

      a?.release();
      await b.taken;

      expect(b.hold).toBeDefined();
    });

    it("the steps of one execution share its slot", async () => {
      const { clock, first, second } = twoInstances();
      const here = slotsOf(first, clock, 1);
      await here.take(claimOf("a"), open);

      const again = await here.take(claimOf("a"), open);
      const elsewhere = await second.acquire("tree:acme:root-1", 1, seconds(30));

      expect(again).toBeDefined();
      expect(elsewhere).toBeUndefined();
    });

    it("a held slot is renewed: past its lease it still counts", async () => {
      const { clock, first, second } = twoInstances();
      await slotsOf(first, clock, 1).take(claimOf("a"), open);

      for (let elapsed = 0; elapsed < minutes(3); elapsed += seconds(10))
        await clock.advance(seconds(10));
      const elsewhere = await second.acquire("tree:acme:root-1", 1, seconds(30));

      expect(elsewhere).toBeUndefined();
    });

    it("a child's own smaller cap is a second lease: both or none", async () => {
      const { clock, first } = twoInstances();
      const here = slotsOf(first, clock, 3);
      const subtree = { executionId: "child-1", maxConcurrentExecutions: 1 };
      await here.take(claimOf("a", [subtree]), open);

      const b = waitingFor(here.take(claimOf("b", [subtree]), open));
      await settled();
      // b's tree lease went back: two of the tree's three slots are still free
      const c = await here.take(claimOf("c"), open);
      const d = await here.take(claimOf("d"), open);

      expect(b.hold).toBeUndefined();
      expect(c).toBeDefined();
      expect(d).toBeDefined();
    });

    it("a waiter whose signal aborts leaves the queue and holds nothing", async () => {
      const { clock, first, second } = twoInstances();
      const here = slotsOf(first, clock, 1);
      const a = await here.take(claimOf("a"), open);
      const cancel = new AbortController();
      const b = here.take(claimOf("b"), cancel.signal);

      cancel.abort();
      const left = await b;
      a?.release();
      await settled();
      const elsewhere = await second.acquire("tree:acme:root-1", 1, seconds(30));

      expect(left).toBeUndefined();
      expect(elsewhere).toBeDefined();
    });
  },
);

@WorkflowStart({ name: "outer-workflow-start", description: "One item", input: ItemDto })
class OuterWorkflowStart {}

/** On its parent's instance, a child that launches its own child on any instance. */
@Workflow({
  name: "outer-workflow",
  version: "1.0.0",
  flow: [
    start(OuterWorkflowStart)
      .returns(ItemDto)
      .toWorkflow(RemoteSpendWorkflow)
      .returns(SummaryDto)
      .toFinish(RemoteSpendCheckedWorkflowFinish),
  ],
})
class OuterWorkflow {}

describe("#333 PR 3: which trees share their slots", () => {
  it("a tree with a launch on any instance, at any depth or by recursion — known from its declarations", () => {
    expect(treeLaunchesOnAnyInstance(RemoteCappedWorkflow)).toBe(true);
    expect(treeLaunchesOnAnyInstance(OuterWorkflow)).toBe(true);
    expect(treeLaunchesOnAnyInstance(RemoteCountdownWorkflow)).toBe(true);
    expect(treeLaunchesOnAnyInstance(RemoteItemWorkflow)).toBe(false);
  });

  it("the registry gives such a tree shared slots, any other in-process ones", () => {
    const kind = kinds[0];
    if (kind === undefined) throw new Error("no store kind");
    const { clock, first } = kind.twoInstances();
    const registry = new TreeSlotRegistry(undefined, undefined, { rateLimits: first, clock });
    const rootOf = (type: Class) => ({
      executionId: type.name,
      workflow: { type },
      tenant: { tenantId: "acme" },
    });

    expect(registry.slotsOf(rootOf(RemoteCappedWorkflow), 2, clock)).toBeInstanceOf(
      SharedTreeSlots,
    );
    expect(registry.slotsOf(rootOf(RemoteItemWorkflow), 2, clock)).toBeInstanceOf(TreeSlots);
  });
});
