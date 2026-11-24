import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Workflow } from "../../../src/index.js";
import { Ttl, days } from "../../../src/units/index.js";
import { onStart } from "../fixtures/paths.js";
import { DraftKitWorkflowFinish, SecondKitWorkflowStart } from "../fixtures/kit.fixture.js";

/**
 * #1318: `@Workflow({ historyTtl })` is a duration above 0, `Ttl.Forever` or `Ttl.None`
 * (`[limits.history-ttl-invalid]`): a value that is none of them would sweep the history of every
 * finished execution at once, or never — assembly refuses it, naming the kind and never the text.
 */

let count = 0;
function workflowWith(historyTtl: unknown): abstract new () => unknown {
  count += 1;
  @Workflow({
    name: `ttl-${String(count)}-workflow`,
    version: "1.0.0",
    historyTtl: historyTtl as never,
    flow: [onStart(SecondKitWorkflowStart).toFinish(DraftKitWorkflowFinish)],
  })
  class TtlWorkflow {}
  return TtlWorkflow;
}

const errorsOf = (historyTtl: unknown) =>
  checkWorkflow(workflowWith(historyTtl)).errors.map(({ code, message }) => ({ code, message }));

describe("#1318: [limits.history-ttl-invalid]", () => {
  it.each([
    ["0", 0, "0"],
    ["a negative number", -1, "-1"],
    ["NaN", Number.NaN, "NaN"],
    ["Infinity", Number.POSITIVE_INFINITY, "Infinity"],
    ["a word", "soon", "a string"],
    ["null", null, "null"],
    ["an object", {}, "an object"],
  ])("%s is refused, named by its kind and never its text", (_kind, value, shown) => {
    const [found, ...rest] = errorsOf(value);

    expect(rest).toEqual([]);
    expect(found?.code).toBe("limits.history-ttl-invalid");
    expect(found?.message).toMatch(
      new RegExp(`^ttl-\\d+-workflow has historyTtl: ${shown}, not a duration above 0`),
    );
    expect(found?.message).not.toContain("soon");
  });

  it("a duration above 0, Ttl.Forever, Ttl.None and none at all pass", () => {
    for (const ttl of [1, days(90), Ttl.Forever, Ttl.None, undefined])
      expect(errorsOf(ttl)).toEqual([]);
  });
});
