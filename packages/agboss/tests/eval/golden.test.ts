import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  goldenFile,
  goldenFromRecent,
  GoldenSetError,
  loadGolden,
  saveGolden,
} from "../../src/eval/golden.js";
import { routeTo, fakeDeps, runText } from "../helpers.js";

describe("golden sets", () => {
  it("AC3: saves the last real tasks (distinct, oldest first) and reads them back", async () => {
    const deps = await fakeDeps({
      "test/router": Array.from({ length: 3 }, () => routeTo("alpha-agent")),
      "test/alpha": ["a", "b", "c"],
    });
    for (const task of ["q1", "q1", "q2"]) await runText(task, deps);
    const file = goldenFile(
      await mkdtemp(join(tmpdir(), "golden-")),
      "test-bundle-workflow",
      "core",
    );

    const set = await goldenFromRecent(
      deps.turns,
      "test-bundle-workflow",
      "core",
      10,
      () => new Date("2026-09-25T00:00:00Z"),
    );
    await saveGolden(file, set);

    // a task is the run's start line (#272 S8): its start and its input
    expect(set.tasks).toEqual([
      { task: 'start chat-workflow-start: {"text":"q1"}' },
      { task: 'start chat-workflow-start: {"text":"q2"}' },
    ]);
    expect(await loadGolden(file)).toEqual(set);
    expect(file).toMatch(/golden\/test-bundle-workflow\/core\.yaml$/);
  });

  it("AC3: an invalid golden file and a bundle without tasks are clear errors", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "golden-")), "bad.yaml");
    await writeFile(file, "name: x\nbundle: b\ncreated: now\ntasks: []\n");

    await expect(loadGolden(file)).rejects.toThrow(`${file}: tasks`);
    await expect(
      goldenFromRecent((await fakeDeps({})).turns, "empty", "x", 5),
    ).rejects.toBeInstanceOf(GoldenSetError);
  });
});
