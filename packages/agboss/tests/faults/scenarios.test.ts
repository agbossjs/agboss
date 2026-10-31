import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FAULT_SCENARIOS, faultSuite, selectedScenarios } from "../../src/testing/faults/index.js";

/** #484 AC1 — every scenario of the suite runs on SQLite in a test file of its own, once. */
const DIR = new URL("./", import.meta.url);

describe("#484 AC1: the scenarios and their files", () => {
  it("every scenario is selected by exactly one file of tests/faults", () => {
    const files = readdirSync(DIR).filter((file) => /^s\d\d-.*\.test\.ts$/u.test(file));
    const selected = files.flatMap((file) =>
      [...readFileSync(new URL(file, DIR), "utf8").matchAll(/"(s\d\d[a-z]?-[a-z0-9-]+)"/gu)].map(
        ([, id]) => id,
      ),
    );
    expect([...selected].sort()).toEqual(FAULT_SCENARIOS.map((scenario) => scenario.id).sort());
  });

  it("selects scenarios by id, in the suite's order, and refuses an unknown one", () => {
    expect(selectedScenarios(undefined)).toBe(FAULT_SCENARIOS);
    expect(
      selectedScenarios(["s02-sigkill-mid-step", "s01-sigterm-drains"]).map((s) => s.id),
    ).toEqual(["s01-sigterm-drains", "s02-sigkill-mid-step"]);
    expect(() => selectedScenarios(["s99-nothing"])).toThrow(/no scenario s99-nothing/u);
    expect(() => {
      faultSuite({ name: "x", stores: "", database: { url: "" }, scenarios: ["s99-nothing"] });
    }).toThrow(RangeError);
  });
});
