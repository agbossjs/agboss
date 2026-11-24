/**
 * #1321d: the threads of one execution tree — a child runs on `<parent>/child/<id>` at any depth —
 * and the in-memory saver's `deleteThread` of a root, which removes all of them and only them.
 */
import { emptyCheckpoint } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import {
  childThreadOf,
  childThreadRangeOf,
  isChildThreadOf,
} from "../../src/infrastructure/checkpoint-threads.js";
import { InMemoryCheckpointSaver } from "../../src/infrastructure/in-memory-checkpoint-saver.js";

const MARK = { source: "input", step: 0, parents: {} } as const;

async function saved(saver: InMemoryCheckpointSaver, thread: string): Promise<void> {
  const config = await saver.put(
    { configurable: { thread_id: thread, checkpoint_ns: "" } },
    emptyCheckpoint(),
    MARK,
  );
  await saver.putWrites(config, [["messages", "pending"]], "task");
}

const has = async (saver: InMemoryCheckpointSaver, thread: string): Promise<boolean> =>
  (await saver.getTuple({ configurable: { thread_id: thread, checkpoint_ns: "" } })) !== undefined;

describe("#1321d: a tree's checkpoint threads", () => {
  it("a child's thread is its parent's, /child/, its id — nested at any depth", () => {
    const child = childThreadOf("root", "a");

    expect(child).toBe("root/child/a");
    expect(isChildThreadOf("root", childThreadOf(child, "b"))).toBe(true);
    expect(isChildThreadOf("root", "root")).toBe(false);
    expect(isChildThreadOf("root", "root-child/a")).toBe(false);
    expect(isChildThreadOf("root", "root/children")).toBe(false);
    expect(isChildThreadOf("root", "other/child/root")).toBe(false);
  });

  it("the range of a root's child threads is [<root>/child/, <root>/child0)", () => {
    expect(childThreadRangeOf("root")).toEqual({ lower: "root/child/", upper: "root/child0" });
    const { lower, upper } = childThreadRangeOf("root");
    for (const id of ["root/child/a", "root/child/a/child/b", "root/child/￿"])
      expect(id >= lower && id < upper).toBe(true);
    for (const id of ["root", "root/child", "root/children", "root/child0", "root2"])
      expect(id >= lower && id < upper).toBe(false);
  });

  it("deleteThread of the root removes the child threads and the writes, no other thread", async () => {
    const saver = new InMemoryCheckpointSaver();
    const doomed = ["root", "root/child/a", "root/child/a/child/b"];
    const kept = ["root2", "root-child", "root/children", "root/child", "other/child/root"];
    for (const id of [...doomed, ...kept]) await saved(saver, id);

    await saver.deleteThread("root");

    for (const id of doomed) expect(await has(saver, id)).toBe(false);
    for (const id of kept) expect(await has(saver, id)).toBe(true);
    expect(
      Object.keys(saver.writes)
        .map((key) => (JSON.parse(key) as string[])[0])
        .sort(),
    ).toEqual([...kept].sort());
  });

  it("deleteThread of a thread nobody wrote is a no-op", async () => {
    const saver = new InMemoryCheckpointSaver();
    await saved(saver, "root2");

    await saver.deleteThread("root");

    expect(await has(saver, "root2")).toBe(true);
  });
});
