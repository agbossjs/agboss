/**
 * #1037 AC2: when a read fails in the concurrent `latestByStep` case, its writer stops and is
 * awaited — no put runs after the case settled, nothing is left unhandled; and a failing writer
 * ends the case with its error instead of leaving the loop reading forever.
 */
import type { RunnableConfig } from "@langchain/core/runnables";
import { MemorySaver, type BaseCheckpointSaver, type CheckpointTuple } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../../src/testing/clock.js";
import { LATEST_BY_STEP_CASES } from "../../../src/testing/contracts/checkpoint-latest-by-step.cases.js";
import type { ContractInstances } from "../../../src/testing/contracts/instance-context.js";

const concurrent = LATEST_BY_STEP_CASES.find((contractCase) =>
  contractCase.name.includes("while another"),
);

/** A saver whose puts are counted and slow, and may fail from the n-th on. */
class CountingSaver extends MemorySaver {
  puts = 0;
  failFrom = Number.POSITIVE_INFINITY;
  override async put(...args: Parameters<MemorySaver["put"]>): ReturnType<MemorySaver["put"]> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.puts += 1;
    if (this.puts >= this.failFrom) throw new Error("the writer failed");
    return super.put(...args);
  }
}

/** A reader that finds nothing (after a turn of the event loop, as a real read) and fails from its n-th call. */
class FailingReader extends MemorySaver {
  reads = 0;
  failFrom = Number.POSITIVE_INFINITY;
  async latestByStep(_config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.reads += 1;
    await new Promise((resolve) => setImmediate(resolve));
    if (this.reads >= this.failFrom) throw new Error("the read failed");
    return undefined;
  }
}

const instances = (
  first: BaseCheckpointSaver,
  second: BaseCheckpointSaver,
): ContractInstances<BaseCheckpointSaver> => ({ clock: new VirtualClock(), first, second });

describe("#1037 AC2: the concurrent latestByStep case does not leak its writer", () => {
  it("AC2: a failing read stops the writer, which is awaited: no put after the case settled, no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): number => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    const writer = new CountingSaver();

    const reader = new FailingReader();
    reader.failFrom = 3;

    await expect(concurrent?.run(instances(writer, reader))).rejects.toThrow("the read failed");
    const settled = writer.puts;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(writer.puts).toBe(settled);
    expect(settled).toBeLessThan(40);
    expect(unhandled).toEqual([]);
    process.off("unhandledRejection", listener);
  });

  it("AC2: a failing writer ends the case with its error", async () => {
    const writer = new CountingSaver();
    writer.failFrom = 3;
    await expect(concurrent?.run(instances(writer, new FailingReader()))).rejects.toThrow();
  });
});
