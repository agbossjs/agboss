/**
 * #831 AC2 — `runConformanceSabotage`, the published helper a store package proves its broken
 * stores fail with: a fixture run in a vitest of its own, every case back with its state and
 * reasons; a fixture that does not load, or a path that names no fixture, rejects — never an empty
 * run a sabotage test could read as "nothing failed, nothing passed".
 */
import { describe, expect, it } from "vitest";
import { runConformanceSabotage } from "../../../src/testing/contracts/index.js";

const ROOT = new URL("../../../", import.meta.url);
const WATCH =
  "a child queued on another instance wakes the watch; it is claimed on the wake-up (#777)";

describe("#831 AC2: runConformanceSabotage", () => {
  it("runs a sabotage fixture apart and gives every case, the failed ones by suite", async () => {
    const run = await runConformanceSabotage({
      root: ROOT,
      fixtures: ["tests/fixtures/contracts/queue-watch-insert-only.contract-fixture.ts"],
      testTimeout: 5000,
    });
    const suite =
      "child execution queue contract (a queue whose watch misses a child queued again)";

    expect(run.isFailed).toBe(true);
    expect(run.failedIn(suite).map((found) => found.name)).toEqual([WATCH]);
    // failed for the rule it breaks: the watch never woke on a child queued again
    expect(run.failedIn(suite)[0]?.errors.join("\n")).toMatch(/Test timed out|timed out/u);
    expect(run.cases.find((found) => found.name === WATCH)).toMatchObject({
      file: "tests/fixtures/contracts/queue-watch-insert-only.contract-fixture.ts",
      suites: [suite],
      state: "fail",
    });
    expect(run.cases.filter((found) => found.state === "pass").length).toBeGreaterThan(10);
  }, 120_000);

  it("a fixture that does not load rejects, naming it", async () => {
    await expect(
      runConformanceSabotage({
        root: ROOT,
        fixtures: ["tests/fixtures/sabotage-run/not-loading.contract-fixture.ts"],
      }),
    ).rejects.toThrow(
      /not-loading\.contract-fixture\.ts did not load: this fixture does not load/u,
    );
  }, 120_000);

  it("a fixture that throws after registering a suite, or whose hook fails, rejects — its failures are no sabotage caught", async () => {
    await expect(
      runConformanceSabotage({
        root: ROOT,
        fixtures: ["tests/fixtures/sabotage-run/partly-loading.contract-fixture.ts"],
      }),
    ).rejects.toThrow(
      /partly-loading\.contract-fixture\.ts did not load: the second suite was refused/u,
    );
    await expect(
      runConformanceSabotage({
        root: ROOT,
        fixtures: ["tests/fixtures/sabotage-run/failing-hook.contract-fixture.ts"],
      }),
    ).rejects.toThrow(/a suite's hook failed — .*a set whose database is down: cannot connect/u);
  }, 120_000);

  it("a path that names no fixture — alone or beside one that runs — or none at all, rejects", async () => {
    await expect(
      runConformanceSabotage({ root: ROOT, fixtures: ["tests/fixtures/sabotage-run/none.ts"] }),
    ).rejects.toThrow(/none\.ts named no fixture file/u);
    await expect(
      runConformanceSabotage({
        root: ROOT,
        fixtures: [
          "tests/fixtures/contracts/queue-watch-insert-only.contract-fixture.ts",
          "tests/fixtures/sabotage-run/typo.contract-fixture.ts",
        ],
        testTimeout: 5000,
      }),
    ).rejects.toThrow(/typo\.contract-fixture\.ts named no fixture file/u);
    await expect(runConformanceSabotage({ root: ROOT, fixtures: [] })).rejects.toThrow(
      /no fixture to run/u,
    );
  }, 120_000);
});
