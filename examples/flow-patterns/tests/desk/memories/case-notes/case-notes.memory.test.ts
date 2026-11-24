import { expect, it } from "vitest";
import { testCompaction } from "@agboss/core/testing";
import { CaseNotesMemory } from "../../../../src/desk/memories/case-notes/case-notes.memory.js";

it("testCompaction: a custom compaction runs its own code, no model request", async () => {
  const compact = testCompaction(CaseNotesMemory);

  const { output } = await compact({
    previousSummaries: [],
    turnsToCompact: [
      {
        start: "desk-workflow-start",
        input: {},
        finish: "desk-answer-workflow-finish",
        output: {},
      },
    ],
  });

  expect(output.requests).toEqual([]);
  expect(output.summaries).toEqual([
    "1 earlier turn(s): desk-workflow-start → desk-answer-workflow-finish",
  ]);
});
