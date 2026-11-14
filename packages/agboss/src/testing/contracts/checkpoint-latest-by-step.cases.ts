import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { expect } from "vitest";
import { hasLatestByStep } from "../../infrastructure/latest-by-step.js";
import type { CapabilityCheck, ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import { StoreCapability } from "./store-capability.js";
import { at, capable, IDS, put, random, scanned } from "./checkpoint-latest-by-step-data.js";

/**
 * #962: a store's `latestByStep` answers what the full scan answers — the checkpoint newest by
 * `(step, id)` — by one indexed read. Run for a store that declares `StoreCapability.LatestByStep`.
 */
const LATEST: CapabilityCheck<BaseCheckpointSaver> = {
  capability: StoreCapability.LatestByStep,
  isPresent: hasLatestByStep,
  without: "a marked thread's latest checkpoint is read by listing its namespace (#962)",
};

type Instances = ContractInstances<BaseCheckpointSaver>;

export const LATEST_BY_STEP_CASES: readonly ContractCase<BaseCheckpointSaver>[] = [
  {
    name: "the newest by step; equal steps by the greatest id (by code unit); none for an empty thread",
    capability: LATEST,
    run: async ({ first, second }: Instances): Promise<void> => {
      expect(await capable(second).latestByStep(at("t"))).toBeUndefined();
      await put(first, at("t"), "b", 1);
      await put(first, at("t"), "a", 5);
      await put(first, at("t"), "Z", 5);
      await put(first, at("t"), "z0", 3);

      // 5 beats 3 whatever the ids; of the tie "Z" < "a" by code unit
      const latest = await capable(second).latestByStep(at("t"));
      expect(latest?.checkpoint.id).toBe("a");
      expect(latest?.checkpoint.channel_values).toEqual({ marker: "a@5" });
      expect(latest?.config.configurable?.checkpoint_id).toBe("a");
      // the checkpoint id of the config is ignored
      const named = { configurable: { thread_id: "t", checkpoint_ns: "", checkpoint_id: "b" } };
      expect((await capable(second).latestByStep(named))?.checkpoint.id).toBe("a");
    },
  },
  {
    name: "a missing step counts as -2; namespaces and threads do not leak into each other",
    capability: LATEST,
    run: async ({ first, second }: Instances): Promise<void> => {
      await put(first, at("t"), "zz", undefined);
      await put(first, at("t"), "aa", -3);
      await put(first, at("t", "child"), "child-1", 9);
      await put(first, at("other"), "other-1", 9);

      expect((await capable(second).latestByStep(at("t")))?.checkpoint.id).toBe("zz");
      expect((await capable(second).latestByStep(at("t", "child")))?.checkpoint.id).toBe("child-1");
      expect(await capable(second).latestByStep(at("t", "grandchild"))).toBeUndefined();
      expect((await capable(second).latestByStep(at("other")))?.checkpoint.id).toBe("other-1");
    },
  },
  {
    name: "a checkpoint put again under its id counts at the step it was last put; deleteThread forgets the thread",
    capability: LATEST,
    run: async ({ first, second }: Instances): Promise<void> => {
      await put(first, at("t"), "x", 1);
      await put(first, at("t"), "y", 2);
      await put(second, at("t"), "x", 7);
      expect((await capable(first).latestByStep(at("t")))?.checkpoint.id).toBe("x");
      await put(first, at("keep"), "k", 1);

      await second.deleteThread("t");

      expect(await capable(first).latestByStep(at("t"))).toBeUndefined();
      expect((await capable(first).latestByStep(at("keep")))?.checkpoint.id).toBe("k");
      await put(first, at("t"), "fresh", -1);
      expect((await capable(second).latestByStep(at("t")))?.checkpoint.id).toBe("fresh");
    },
  },
  {
    name: "on random histories, with a clock step-back, it answers what the full scan answers, from either instance",
    capability: LATEST,
    run: async ({ first, second }: Instances): Promise<void> => {
      const next = random(962);
      const places = [at("t"), at("t", "child"), at("t", "child|grand")];
      for (let round = 0; round < 60; round += 1) {
        const where = places[Math.floor(next() * places.length)] ?? at("t");
        const id = IDS[Math.floor(next() * IDS.length)] ?? "a";
        // a step back: ids and steps fall for a while, as after the host's clock stepped back
        const step = next() < 0.1 ? undefined : Math.floor(next() * 6) - 1;
        await put(round % 2 === 0 ? first : second, where, id, step);
        for (const place of places) {
          const reader = round % 3 === 0 ? first : second;
          const expected = await scanned(reader, place);
          expect((await capable(reader).latestByStep(place))?.checkpoint.id).toBe(expected);
        }
      }
    },
  },
  {
    name: "while another instance writes, every answer is a whole stored checkpoint and never goes back",
    capability: LATEST,
    run: async ({ first, second }: Instances): Promise<void> => {
      const writes = 40;
      let written = 0;
      let writing = true;
      let stopped = false;
      // the writer stops when a read fails, and is awaited either way: none is left running
      const writer = (async () => {
        try {
          for (let step = 0; step < writes && !stopped; step += 1) {
            await put(first, at("t"), `id-${String(step).padStart(3, "0")}`, step);
            written = step + 1;
          }
        } finally {
          writing = false;
        }
      })();
      let seen = -1;
      try {
        while (writing) {
          const tuple = await capable(second).latestByStep(at("t"));
          if (tuple === undefined) continue;
          const step = Number(tuple.checkpoint.id.slice(3));
          expect(tuple.checkpoint.channel_values).toEqual({
            marker: `${tuple.checkpoint.id}@${String(step)}`,
          });
          expect(tuple.metadata).toMatchObject({ step });
          expect(step).toBeGreaterThanOrEqual(seen);
          expect(step).toBeLessThanOrEqual(written);
          seen = step;
        }
      } finally {
        stopped = true;
        await writer;
      }
      expect((await capable(second).latestByStep(at("t")))?.checkpoint.id).toBe("id-039");
    },
  },
];
