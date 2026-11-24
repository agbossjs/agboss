import { describe, expect, it } from "vitest";
import {
  explainedRuleCodes,
  parseRuleCatalog,
  ruleExplanationOf,
} from "../../../src/core/diagnostics/rule-catalog.js";

/**
 * #1325c: `agboss explain` and a snippet's `= note:` read the skills' catalog. That it lists every
 * assembly rule code is `tests/docs/skills.test.ts`'s check; here the reading.
 */

describe("the rule catalog", () => {
  it("reads a code's meaning and its before → after from the shipped skills", () => {
    expect(ruleExplanationOf("graph.dead-end")).toEqual({
      means: "a path, case, group or side path stops before a finish",
      fix: "`.toAgent(X)` as the last call → `.toAgent(X)` `.toFinish(F)`",
    });
    expect(explainedRuleCodes().length).toBeGreaterThan(250);
    expect(ruleExplanationOf("no.such-code")).toBeUndefined();
  });
});

describe("parseRuleCatalog", () => {
  const TABLE = [
    "| Code | Means | Before → after |",
    "| ---- | ----- | -------------- |",
    "| `[a.one]` | the first | `x` → `y` |",
    "| `[a.two]` | only a meaning |",
    "| `[a.pipe]` | a union | `A \\| B` → `A` |",
    "| `[a.one]` | the same code again | ignored |",
    "some prose with `[a.prose]` in it",
  ].join("\n");

  it("takes the rows of a table: a meaning, a fix, an escaped pipe inside a cell", () => {
    expect(Object.fromEntries(parseRuleCatalog(TABLE))).toEqual({
      "a.one": { means: "the first", fix: "`x` → `y`" },
      "a.two": { means: "only a meaning" },
      "a.pipe": { means: "a union", fix: "`A | B` → `A`" },
    });
  });
});
