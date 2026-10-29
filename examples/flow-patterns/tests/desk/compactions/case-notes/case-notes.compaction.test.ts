import { expect, it } from "vitest";
import { testCompaction } from "@agboss/core/testing";
import { CaseNotesCompaction } from "../../../../src/desk/compactions/case-notes/case-notes.compaction.js";

it("testCompaction: a custom compaction runs its own code, no model request", async () => {
  const compact = testCompaction(CaseNotesCompaction);

  const { output } = await compact({
    previousSummaries: [],
    turnsToCompact: [
      {
        startName: "desk-workflow-start",
        input: {},
        finishName: "desk-answer-workflow-finish",
        output: {},
      },
    ],
  });

  expect(output.requests).toEqual([]);
  expect(output.summaries).toEqual([
    "1 earlier turn(s): desk-workflow-start → desk-answer-workflow-finish",
  ]);
});
