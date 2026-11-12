import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { watchSources } from "../../src/cli/watch.js";

/** #920: one smoke case on a real folder, asserting only what any timing satisfies (watch.test.ts has the rest). */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("#920: the watch loop on the operating system's file watch", () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const directory of folders.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("a written source reaches a pass; passes never overlap", async () => {
    const folder = mkdtempSync(join(tmpdir(), "agboss-watch-"));
    folders.push(folder);
    const file = join(folder, "a.agent.ts");
    const passes: (readonly string[])[] = [];
    let running = 0;
    let overlaps = 0;
    const controller = new AbortController();
    const loop = watchSources({
      folder,
      debounce: 20,
      signal: controller.signal,
      pass: async (changed) => {
        passes.push(changed);
        running += 1;
        if (running > 1) overlaps += 1;
        await settle();
        running -= 1;
      },
    });
    // the system's watch may report late, once, or not at all: write again until a pass has the
    // file; the test's own timeout is the bound
    while (!passes.some((changed) => changed.includes("a.agent.ts"))) {
      writeFileSync(file, `export {};\n// ${String(passes.length)}\n`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    controller.abort();
    await loop;

    expect(overlaps).toBe(0);
  }, 60_000);
});
