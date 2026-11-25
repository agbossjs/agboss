/**
 * #1324: the graph engine of 0.1.1 is LangGraph, and no LangGraph type is part of the public API of
 * the root, the stores, the describe, the testing or the testing/faults entries — a store author reads `@agboss/core/stores` for pure
 * functions (`stepOf`, `NO_STEP`, …), and the savers that hold LangGraph types live in
 * `@agboss/core/internal`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const reports = new URL("../../api/", import.meta.url).pathname;
const reportOf = (name: string): string => readFileSync(join(reports, name), "utf8");

describe("#1324: LangGraph stays out of the public API", () => {
  it.each([
    "agboss.api.md",
    "agboss-stores.api.md",
    "agboss-describe.api.md",
    "agboss-testing.api.md",
    "agboss-testing-faults.api.md",
  ])("%s imports nothing from LangGraph", (name) => {
    expect(reportOf(name)).not.toMatch(/@langchain\/langgraph/);
  });

  it("the checkpoint savers are internal; the stores keep the pure functions", () => {
    const internal = reportOf("agboss-internal.api.md");
    const stores = reportOf("agboss-stores.api.md");

    for (const name of [
      "SqliteCheckpointSaver",
      "LatestByStepCheckpointSaver",
      "hasLatestByStep",
    ]) {
      expect(internal).toContain(name);
      expect(stores).not.toContain(name);
    }
    for (const name of [
      "stepOf",
      "NO_STEP",
      "compareCodePoints",
      "newestFirstOrder",
      "childThreadOf",
    ]) {
      expect(stores).toContain(name);
    }
  });
});
