import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FAULT_SABOTAGE_SCENARIOS,
  FAULT_SCENARIOS,
  faultSuite,
  type FaultSuiteOptions,
} from "../../src/testing/faults/index.js";
import { faultShardOf, faultSuitePlanOf } from "../../src/testing/faults/fault-suite.js";
import { SCENARIOS } from "../../src/testing/faults/scenarios/index.js";
import { SABOTAGES } from "../../src/testing/faults/scenarios/sabotages.js";

/** #484 AC1 — every scenario of the suite runs on SQLite in a test file of its own, once. */
const DIR = new URL("./", import.meta.url);

const BASE: FaultSuiteOptions = { name: "x", storesModule: "", database: { url: "" } };

/** A value a JavaScript caller could pass, typed as the option it is not. */
const untypedFlag = (value: unknown): boolean => value as boolean;
const ALL = [...FAULT_SCENARIOS, ...FAULT_SABOTAGE_SCENARIOS].map((scenario) => scenario.id);

/** The ids of the cases a plan runs. */
const runsOf = (options: Partial<FaultSuiteOptions>, env: NodeJS.ProcessEnv = {}): string[] =>
  faultSuitePlanOf({ ...BASE, ...options }, env)
    .cases.filter((one) => one.skipped === undefined)
    .map((one) => one.scenario.id);

describe("#484 AC1: the scenarios and their files", () => {
  it("every scenario is selected by exactly one file of tests/faults", () => {
    const files = readdirSync(DIR).filter((file) => /^s\d\d-.*\.test\.ts$/u.test(file));
    const selected = files.flatMap((file) =>
      [...readFileSync(new URL(file, DIR), "utf8").matchAll(/"(s\d\d[a-z]?\d?-[a-z0-9-]+)"/gu)].map(
        ([, id]) => id,
      ),
    );
    expect([...selected].sort()).toEqual(FAULT_SCENARIOS.map((scenario) => scenario.id).sort());
  });

  it("#831: the published lists name the suite's scenarios and sabotages, nothing to run", () => {
    expect(FAULT_SCENARIOS.map((one) => one.id)).toEqual(SCENARIOS.map((one) => one.id));
    expect(FAULT_SABOTAGE_SCENARIOS.map((one) => one.id)).toEqual([
      "s05e-zombie-dies-unanswered",
      "s06c-sabotage-finished-child-granted",
      "s14-sabotage-every-error-definite",
      "s15-sabotage-replay-trusted-as-lookup",
      "s22-sabotage-unknown-as-not-sent",
      "s22-sabotage-unknown-as-done",
      "s23-sabotage-reset-as-definite",
    ]);
    for (const one of [...FAULT_SCENARIOS, ...FAULT_SABOTAGE_SCENARIOS]) {
      expect(Object.keys(one).sort()).toEqual(["id", "title"]);
      expect(Object.isFrozen(one)).toBe(true);
    }
  });
});

describe("#831 AC2: what the suite runs, and what it shows it leaves out", () => {
  it("by default: every scenario, then every sabotage; the first case counts them", () => {
    const plan = faultSuitePlanOf(BASE, {});

    expect(plan.cases.map((one) => one.scenario.id)).toEqual(ALL);
    expect(plan.cases.every((one) => one.skipped === undefined)).toBe(true);
    expect(
      plan.cases.filter((one) => one.sabotage !== undefined).map((one) => one.scenario.id),
    ).toEqual(SABOTAGES.map((one) => one.id));
    expect(plan.summary).toBe(
      `runs ${String(ALL.length)} of ${String(ALL.length)} cases: ${String(SCENARIOS.length)} of ${String(SCENARIOS.length)} scenarios, 7 of 7 sabotages`,
    );
  });

  it("scenarios: selects by id — a sabotage's too —, in the suite's order; the others skipped, with the reason", () => {
    const plan = faultSuitePlanOf(
      {
        ...BASE,
        scenarios: [
          "s15-sabotage-replay-trusted-as-lookup",
          "s02-sigkill-mid-step",
          "s01-sigterm-drains",
        ],
      },
      {},
    );

    expect(runsOf({ scenarios: ["s02-sigkill-mid-step", "s01-sigterm-drains"] })).toEqual([
      "s01-sigterm-drains",
      "s02-sigkill-mid-step",
    ]);
    expect(plan.cases.filter((one) => one.skipped !== undefined)).toHaveLength(ALL.length - 3);
    expect(new Set(plan.cases.flatMap((one) => one.skipped ?? []))).toEqual(
      new Set(["not selected: scenarios: names others"]),
    );
    expect(plan.summary).toBe(
      `runs 3 of ${String(ALL.length)} cases: 2 of ${String(SCENARIOS.length)} scenarios, 1 of 7 sabotages (selected by scenarios:)`,
    );
  });

  it("an unknown id is refused, by the plan and by faultSuite", () => {
    expect(() => faultSuitePlanOf({ ...BASE, scenarios: ["s99-nothing"] }, {})).toThrow(
      /no scenario s99-nothing/u,
    );
    expect(() => {
      faultSuite({ ...BASE, scenarios: ["s99-nothing"] });
    }).toThrow(RangeError);
  });

  it("shards: every case in exactly one shard, for any count — the sabotages too", () => {
    for (const count of [1, 2, 3, 5, ALL.length]) {
      const ids = Array.from({ length: count }, (_, at) =>
        runsOf({ shard: { index: at + 1, count } }),
      ).flat();
      expect([...ids].sort()).toEqual([...ALL].sort());
    }
  });

  it("a shard of a selection splits the selection; the summary names the shard", () => {
    const scenarios = [
      "s01-sigterm-drains",
      "s02-sigkill-mid-step",
      "s14-sabotage-every-error-definite",
    ];

    expect(runsOf({ scenarios, shard: { index: 1, count: 2 } })).toEqual([
      "s01-sigterm-drains",
      "s14-sabotage-every-error-definite",
    ]);
    const plan = faultSuitePlanOf({ ...BASE, scenarios, shard: { index: 2, count: 2 } }, {});
    expect(plan.cases.find((one) => one.scenario.id === "s01-sigterm-drains")?.skipped).toBe(
      "in another shard than 2/2",
    );
    expect(plan.summary).toMatch(/\(selected by scenarios:, shard 2\/2\)$/u);
  });

  it('shard: "env" reads AGBOSS_FAULT_SHARD; unset or empty runs every case', () => {
    expect(runsOf({ shard: "env" }, { AGBOSS_FAULT_SHARD: "2/3" })).toEqual(
      runsOf({ shard: { index: 2, count: 3 } }),
    );
    expect(runsOf({ shard: "env" }, {})).toEqual(ALL);
    expect(runsOf({ shard: "env" }, { AGBOSS_FAULT_SHARD: "" })).toEqual(ALL);
    // without "env" the variable is not read
    expect(runsOf({}, { AGBOSS_FAULT_SHARD: "2/3" })).toEqual(ALL);
  });

  it("a malformed shard is refused, never a run of nothing", () => {
    for (const text of ["0/3", "4/3", "1/0", "3", "1/3/1", " 1/3", "a/b", "-1/3"]) {
      expect(() => faultShardOf(text)).toThrow(RangeError);
      expect(() => runsOf({ shard: "env" }, { AGBOSS_FAULT_SHARD: text })).toThrow(RangeError);
    }
    for (const shard of [
      { index: 0, count: 2 },
      { index: 3, count: 2 },
      { index: 1.5, count: 2 },
      { index: 1, count: 0 },
    ])
      expect(() => runsOf({ shard })).toThrow(/whole numbers with 1 ≤ index ≤ count/u);
    expect(faultShardOf("2/3")).toEqual({ index: 2, count: 3 });
  });

  it("options that would run nothing are refused: an empty selection, more shards than cases, only sabotages turned off", () => {
    expect(() => runsOf({ scenarios: [] })).toThrow(/scenarios: \[\] selects nothing/u);
    expect(() => runsOf({ shard: { index: 1, count: ALL.length + 1 } })).toThrow(
      /shards of \d+ cases — some shard would run nothing/u,
    );
    expect(() =>
      runsOf({
        scenarios: ["s01-sigterm-drains", "s02-sigkill-mid-step"],
        shard: { index: 3, count: 3 },
      }),
    ).toThrow(/3 shards of 2 cases/u);
    expect(() =>
      runsOf({ scenarios: ["s14-sabotage-every-error-definite"], sabotages: false }),
    ).toThrow(/leave no case to run/u);
  });

  it("sabotages: false skips the sabotages, with the reason — never a pass", () => {
    const plan = faultSuitePlanOf({ ...BASE, sabotages: false }, {});
    const skipped = plan.cases.filter((one) => one.skipped !== undefined);

    expect(skipped.map((one) => one.scenario.id)).toEqual(SABOTAGES.map((one) => one.id));
    expect(skipped[0]?.skipped).toMatch(/^sabotages: false — /u);
    expect(plan.summary).toMatch(/0 of 7 sabotages \(sabotages: false\)$/u);
    expect(() => faultSuitePlanOf({ ...BASE, sabotages: untypedFlag("no") }, {})).toThrow(
      /sabotages is no — true or false/u,
    );
  });
});
