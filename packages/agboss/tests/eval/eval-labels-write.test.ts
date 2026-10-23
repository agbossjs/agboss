/**
 * #397 PR 4 — what `agboss eval ui` writes and reads besides the page: a label put into a labels
 * file (the same run, judge and labeler replaced, else appended — still what `evalLabelsOf` reads),
 * a label checked from a form, and the project's failure taxonomy.
 */
import { describe, expect, it } from "vitest";
import { evalLabelOf, evalLabelsOf, labelsWith } from "../../src/eval/calibrate/labels.js";
import { failureTaxonomyOf } from "../../src/eval/calibrate/taxonomy.js";
import type { EvalLabel } from "../../src/eval/calibrate/calibration.js";

const label = (parts: Partial<EvalLabel> = {}): EvalLabel => ({
  runId: "refund#1",
  executionId: "e-1",
  judge: "grounded-judge",
  labeler: "anna",
  passed: true,
  failureTags: [],
  ...parts,
});

describe("#397 PR 4: a label put into a labels file", () => {
  it("appended to an empty or another file, one JSON line each", () => {
    const once = labelsWith("", label());
    const twice = labelsWith(once, label({ labeler: "boris", passed: false }));

    expect(twice.split("\n").filter((line) => line !== "")).toHaveLength(2);
    expect(evalLabelsOf(twice)).toMatchObject({
      kind: "read",
      labels: [{ labeler: "anna" }, { labeler: "boris" }],
    });
  });

  it("the same run, judge and labeler replaced in place", () => {
    const first = labelsWith(
      labelsWith("", label()),
      label({ executionId: "e-2", runId: "refund#2" }),
    );

    const again = labelsWith(first, label({ passed: false, note: "changed my mind" }));

    const read = evalLabelsOf(again);
    expect(read).toMatchObject({ kind: "read" });
    expect(
      read.kind === "read" ? read.labels.map((each) => [each.executionId, each.passed]) : [],
    ).toEqual([
      ["e-1", false],
      ["e-2", true],
    ]);
  });

  it("a file that does not read is not rewritten", () => {
    expect(() => labelsWith("{ broken", label())).toThrow("line 1: not JSON");
  });

  it("a label from a form is checked as a line is", () => {
    expect(evalLabelOf(label())).toEqual({ kind: "read", label: label() });
    expect(evalLabelOf({ ...label(), score: 5 })).toMatchObject({
      kind: "invalid",
      reason: expect.stringMatching(/^score: /u) as unknown,
    });
  });
});

describe("#397 PR 4: the failure taxonomy", () => {
  it("its tags, each with what it means", () => {
    const read = failureTaxonomyOf(`tags:
  - tag: wrong-tool
    description: called a tool the task did not need
  - tag: missed-policy
    description: answered without check_policy
`);

    expect(read).toEqual({
      kind: "read",
      tags: [
        { tag: "wrong-tool", description: "called a tool the task did not need" },
        { tag: "missed-policy", description: "answered without check_policy" },
      ],
    });
  });

  it.each([
    ["not YAML", "tags: [", /^not YAML: /u],
    ["no tags", "other: 1", /^tags: /u],
    [
      "a tag that is not kebab-case",
      "tags:\n  - tag: Wrong Tool\n    description: x",
      /^tags\.0\.tag: a kebab-case tag/u,
    ],
    [
      "a tag twice",
      "tags:\n  - tag: a\n    description: x\n  - tag: a\n    description: y",
      /^tag a twice$/u,
    ],
  ])("%s is refused, saying why", (_what, content, reason) => {
    const read = failureTaxonomyOf(content);

    expect(read.kind).toBe("invalid");
    expect(read.kind === "invalid" ? read.reason : "").toMatch(reason);
  });
});
