/**
 * #1356 — the small readers of a call's usage, each mutated by the `spend` shard: the fallback's
 * mark, the host that served a call, the cost category of a caller.
 */
import { describe, expect, it } from "vitest";
import {
  CostCategory,
  NO_COST_BY_CATEGORY,
  costCategoryOf,
} from "../../src/finops/cost-category.js";
import { FALLBACK_MARK, fallbackMarkOf, isRecord } from "../../src/finops/fallback-mark.js";
import { SERVED_BY_FIELD, servedByOf } from "../../src/finops/served-by.js";

describe("#1356: isRecord", () => {
  it("is an object that is neither null nor an array", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("text")).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe("#1356: the fallback's mark", () => {
  it("is named by the field the fallback writes", () => {
    expect(FALLBACK_MARK).toBe("agboss_fallback");
  });

  it("reads the model, and priced only when it is true", () => {
    const of = (mark: unknown) => fallbackMarkOf({ usage: { [FALLBACK_MARK]: mark } });

    expect(of({ model: "backup/m", priced: true })).toEqual({ model: "backup/m", priced: true });
    expect(of({ model: "backup/m", priced: false })).toEqual({ model: "backup/m", priced: false });
    expect(of({ model: "backup/m" })).toEqual({ model: "backup/m", priced: false });
    expect(of({ model: "backup/m", priced: "true" })).toEqual({ model: "backup/m", priced: false });
  });

  it("is none when no fallback served the call, or the mark is not a model's", () => {
    const of = (mark: unknown) => fallbackMarkOf({ usage: { [FALLBACK_MARK]: mark } });

    expect(fallbackMarkOf(undefined)).toBeUndefined();
    expect(fallbackMarkOf({})).toBeUndefined();
    expect(fallbackMarkOf({ usage: "agboss_fallback" })).toBeUndefined();
    expect(fallbackMarkOf({ usage: null })).toBeUndefined();
    expect(fallbackMarkOf({ usage: [] })).toBeUndefined();
    expect(fallbackMarkOf({ usage: {} })).toBeUndefined();
    expect(of(null)).toBeUndefined();
    expect(of([])).toBeUndefined();
    expect(of("backup/m")).toBeUndefined();
    expect(of({ priced: true })).toBeUndefined();
    expect(of({ model: 7, priced: true })).toBeUndefined();
    // an array holding the keys is not the mark either
    expect(of(Object.assign([], { model: "backup/m" }))).toBeUndefined();
  });
});

describe("#1356: the host that served a call", () => {
  it("is named by the field the client copies the host into", () => {
    expect(SERVED_BY_FIELD).toBe("agboss_served_by");
  });

  it("is the host the usage names", () => {
    expect(servedByOf({ usage: { [SERVED_BY_FIELD]: "DeepInfra" } })).toBe("DeepInfra");
  });

  it("is none when the usage names none, an empty one or a host that is no text", () => {
    expect(servedByOf(undefined)).toBeUndefined();
    expect(servedByOf({})).toBeUndefined();
    expect(servedByOf({ usage: null })).toBeUndefined();
    expect(servedByOf({ usage: "DeepInfra" })).toBeUndefined();
    expect(servedByOf({ usage: [] })).toBeUndefined();
    expect(servedByOf({ usage: {} })).toBeUndefined();
    expect(servedByOf({ usage: { [SERVED_BY_FIELD]: "" } })).toBeUndefined();
    expect(servedByOf({ usage: { [SERVED_BY_FIELD]: 7 } })).toBeUndefined();
    expect(servedByOf({ usage: { [SERVED_BY_FIELD]: ["DeepInfra"] } })).toBeUndefined();
  });
});

describe("#1356: the cost category of a caller", () => {
  it.each([
    ["judge:fact-check", CostCategory.Review],
    ["tool:search", CostCategory.Tools],
    ["action:refund", CostCategory.Tools],
    ["compaction:thread", CostCategory.Memory],
    ["rag:rerank", CostCategory.Rag],
    ["files:describe", CostCategory.Files],
    ["guardrail:pii", CostCategory.Guardrails],
    ["router:quality:pick", CostCategory.Review],
    ["router:pick", CostCategory.Routing],
    ["writer", CostCategory.Agents],
  ])("%s is %s", (caller, category) => {
    expect(costCategoryOf(caller)).toBe(category);
  });

  it("reads a prefix, not a word inside the name", () => {
    for (const caller of [
      "my-judge:x",
      "x:judge:",
      "the-tool:a",
      "my-action:a",
      "x-rag:a",
      "x-files:a",
      "x-compaction:a",
      "x-guardrail:a",
      "x-router:a",
    ])
      expect(costCategoryOf(caller)).toBe(CostCategory.Agents);
  });

  it("starts a cost report with every category at nothing", () => {
    expect(Object.keys(NO_COST_BY_CATEGORY).sort()).toEqual(Object.values(CostCategory).sort());
    expect(Object.values(NO_COST_BY_CATEGORY).every((cost) => cost === 0)).toBe(true);
  });
});
