/**
 * #1321d: the threads of one execution tree — a child runs on `<parent>/child/<id>` at any depth —
 * and the savers' `deleteThread` of a root, which removes the threads that store that root and no
 * other: never by a range of thread ids, and no id holds the separator.
 */
import { emptyCheckpoint } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import {
  childThreadOf,
  rootExecutionIdOf,
  ROOT_EXECUTION_ID_KEY,
} from "../../src/infrastructure/checkpoint-threads.js";
import { InMemoryCheckpointSaver } from "../../src/infrastructure/in-memory-checkpoint-saver.js";
import { SqliteCheckpointSaver } from "../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import { KeyTextRule, keyTextRuleOf } from "../../src/errors.js";
import { connectionTo, temporarySqlitePath } from "./contracts/store-kinds.js";

const MARK = { source: "input", step: 0, parents: {} } as const;

type Saver = InMemoryCheckpointSaver | SqliteCheckpointSaver;

async function saved(saver: Saver, thread: string, root?: string): Promise<void> {
  const config = await saver.put(
    {
      configurable: {
        thread_id: thread,
        checkpoint_ns: "",
        ...(root === undefined ? {} : { [ROOT_EXECUTION_ID_KEY]: root }),
      },
    },
    emptyCheckpoint(),
    MARK,
  );
  await saver.putWrites(config, [["messages", "pending"]], "task");
}

const has = async (saver: Saver, thread: string): Promise<boolean> =>
  (await saver.getTuple({ configurable: { thread_id: thread, checkpoint_ns: "" } })) !== undefined;

const hasWrites = async (saver: Saver, thread: string): Promise<boolean> =>
  ((await saver.getTuple({ configurable: { thread_id: thread, checkpoint_ns: "" } }))?.pendingWrites
    ?.length ?? 0) > 0;

const SAVERS: readonly (readonly [string, () => Saver])[] = [
  ["in-memory", () => new InMemoryCheckpointSaver()],
  ["SQLite", () => new SqliteCheckpointSaver(connectionTo(temporarySqlitePath()))],
];

describe("#1321d: a tree's checkpoint threads", () => {
  it("a child's thread is its parent's, /child/, its id — nested at any depth", () => {
    expect(childThreadOf(childThreadOf("root", "a"), "b")).toBe("root/child/a/child/b");
  });

  it("a thread's root is the one its config names, else its id's first segment", () => {
    expect(rootExecutionIdOf({ thread_id: "root/child/a/child/b" })).toBe("root");
    expect(rootExecutionIdOf({ thread_id: "root" })).toBe("root");
    expect(rootExecutionIdOf({ thread_id: "/child/c", [ROOT_EXECUTION_ID_KEY]: "r" })).toBe("r");
    expect(rootExecutionIdOf({})).toBeUndefined();
  });
});

describe("#1321d: the child separator is reserved", () => {
  it.each(["a/child/x", "/child/", "root/child/x-evil", "a/child/b/child/c"])(
    "%s is refused as a key, naming the rule and not the text",
    (id) => {
      expect(keyTextRuleOf(id)).toBe(KeyTextRule.ReservedSeparator);
    },
  );

  it.each(["a", "a0", "root-child", "root/children", "child", "a/child", "child/a"])(
    "%s is a key text as before",
    (id) => {
      expect(keyTextRuleOf(id)).toBeUndefined();
    },
  );
});

describe.each(SAVERS)("#1321d: deleteThread by root, %s saver", (_name, make) => {
  it("a tree with root a deletes its own threads, never those of a/child/x-evil or a0", async () => {
    const saver = make();
    // a text a client might pick so that a range or a prefix of `a` reaches it
    const ours = [
      ["a", "a"],
      ["a/child/b", "a"],
      ["a/child/b/child/c", "a"],
    ] as const;
    const others = [
      ["a/child/x-evil", "a/child/x-evil"],
      ["a/child/x-evil/child/y", "a/child/x-evil"],
      ["a0", "a0"],
      ["a/child0", "a/child0"],
      ["a-child", "a-child"],
      ["a/children", "a/children"],
      ["other/child/a", "other"],
    ] as const;
    for (const [id, root] of [...ours, ...others]) await saved(saver, id, root);

    await saver.deleteThread("a");

    for (const [id] of ours) {
      expect(await has(saver, id)).toBe(false);
      expect(await hasWrites(saver, id)).toBe(false);
    }
    for (const [id] of others) {
      expect(await has(saver, id)).toBe(true);
      expect(await hasWrites(saver, id)).toBe(true);
    }
  });

  it("a thread written without a root names itself, or the first segment of its id", async () => {
    const saver = make();
    await saved(saver, "r");
    await saved(saver, "r/child/c");
    await saved(saver, "r2");

    await saver.deleteThread("r");

    expect(await has(saver, "r")).toBe(false);
    expect(await has(saver, "r/child/c")).toBe(false);
    expect(await has(saver, "r2")).toBe(true);
  });

  it("deleteThread of a thread nobody wrote is a no-op", async () => {
    const saver = make();
    await saved(saver, "root2");

    await saver.deleteThread("root");

    expect(await has(saver, "root2")).toBe(true);
  });
});
