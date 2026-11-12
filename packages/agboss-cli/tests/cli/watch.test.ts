import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSourceChange, watchSources } from "../../src/cli/watch.js";

/**
 * #268 AC6, #920: the watch loop of `agboss dev` runs on a fake watcher that reports a change when a test says so and on fake timers
 * that move when a test says so; no file system event, no real timer, so no machine load decides
 * what the loop sees. The operating system's own watch is watch-system.test.ts.
 */

const DEBOUNCE = 100;
/** Lets the loop take in a pass's end: promise continuations run before a macrotask. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The loop on a fake watcher, its passes recorded; each pass runs until the test releases it. */
function watching() {
  const passes: (readonly string[])[] = [];
  const passEnds: (() => void)[] = [];
  let emit: (file: string) => void = () => undefined;
  let closed = false;
  let running = 0;
  let overlaps = 0;
  const controller = new AbortController();
  const loop = watchSources({
    folder: "/watched",
    debounce: DEBOUNCE,
    signal: controller.signal,
    watcher: (_folder, onFile) => {
      emit = onFile;
      return {
        close: () => {
          closed = true;
        },
      };
    },
    pass: async (changed) => {
      passes.push(changed);
      running += 1;
      if (running > 1) overlaps += 1;
      await new Promise<void>((resolve) => passEnds.push(resolve));
      running -= 1;
    },
  });
  return {
    passes,
    overlaps: (): number => overlaps,
    isClosed: (): boolean => closed,
    /** The watcher reports `file` changed. */
    change: (file: string): void => {
      emit(file);
    },
    /** Moves the clock; a debounce whose quiet time has passed fires. */
    advance: (milliseconds: number): void => {
      vi.advanceTimersByTime(milliseconds);
    },
    /** Ends the oldest running pass and lets the loop take its end in. */
    release: async (): Promise<void> => {
      passEnds.shift()?.();
      await settle();
    },
    stop: async (): Promise<void> => {
      controller.abort();
      for (const end of passEnds.splice(0)) end();
      await loop;
    },
  };
}

describe("#268 AC6: the watch loop", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("one pass at start, then one per burst of changes (debounced)", async () => {
    const watch = watching();
    await watch.release();

    watch.change("a.agent.ts");
    watch.advance(DEBOUNCE - 1);
    watch.change("a.prompt.md"); // a change inside the quiet time restarts it
    watch.change("a.agent.ts");
    watch.advance(DEBOUNCE - 1);
    expect(watch.passes).toHaveLength(1); // the burst waits for its quiet time
    watch.advance(1);
    await watch.stop();

    expect(watch.passes).toHaveLength(2);
    expect(watch.passes[0]).toEqual([]);
    expect([...(watch.passes[1] ?? [])].sort()).toEqual(["a.agent.ts", "a.prompt.md"]);
  });

  it("a change during a pass makes one more pass after it; passes never overlap", async () => {
    const watch = watching();

    // the start's pass is still running: both changes land while it runs
    watch.change("c.workflow.ts");
    watch.advance(DEBOUNCE);
    watch.change("d.workflow.ts");
    watch.advance(DEBOUNCE);
    expect(watch.passes).toHaveLength(1);
    await watch.release();
    expect(watch.passes).toHaveLength(2); // started by the end of the first
    await watch.release();
    watch.advance(10 * DEBOUNCE);
    await watch.stop();

    expect(watch.passes).toHaveLength(2);
    expect([...(watch.passes[1] ?? [])].sort()).toEqual(["c.workflow.ts", "d.workflow.ts"]);
    expect(watch.overlaps()).toBe(0);
  });

  it("#878: a debounce still armed when a pass ends starts no empty pass after the next one", async () => {
    const watch = watching();

    watch.change("c.workflow.ts");
    watch.advance(DEBOUNCE); // fires during the start's pass: one more pass is due
    watch.change("d.workflow.ts"); // its debounce is armed, not fired
    await watch.release(); // the pass due runs at once, with both
    expect(watch.passes).toHaveLength(2);
    await watch.release();
    watch.advance(DEBOUNCE); // d's debounce, were it still armed
    await watch.stop();

    expect([...(watch.passes[1] ?? [])].sort()).toEqual(["c.workflow.ts", "d.workflow.ts"]);
    expect(watch.passes).toHaveLength(2);
    expect(watch.passes.slice(1).filter((changed) => changed.length === 0)).toEqual([]);
  });

  it("dependencies, builds and the generated files never start a pass", async () => {
    const watch = watching();
    await watch.release();

    for (const file of [
      join("node_modules", "types.d.ts"),
      join("dist", "types.d.ts"),
      join(".agboss", "types.d.ts"),
      "notes.txt",
    ])
      watch.change(file);
    watch.advance(10 * DEBOUNCE);
    await watch.stop();

    expect(watch.passes).toEqual([[]]);
  });

  it("ends: the watcher closes, a change after the end starts nothing, the running pass is awaited", async () => {
    const watch = watching();

    watch.change("a.agent.ts");
    await watch.stop();
    expect(watch.isClosed()).toBe(true);
    watch.change("b.agent.ts");
    watch.advance(10 * DEBOUNCE);

    expect(watch.passes).toEqual([[]]);
  });

  it.each([
    ["src/agents/a.agent.ts", true],
    ["src/agents/a.prompt.md", true],
    ["profiles/offer-workflow/cheap.yaml", true],
    ["src/.agboss/types.d.ts", false],
    ["node_modules/agboss/dist/index.js", false],
    ["src/data/resume.pdf", false],
  ])("%s is a source change: %s", (file, expected) => {
    expect(isSourceChange(file)).toBe(expected);
  });
});
