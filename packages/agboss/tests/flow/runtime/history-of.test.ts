import { beforeEach, describe, expect, it } from "vitest";
import { analyseWorkflow } from "../../../src/flow/analyse/analyse.js";
import { inputMessageOf } from "../../../src/flow/runtime/input-message.js";
import {
  OutdatedReason,
  type OutdatedValueRecord,
  type ScopeValueRecord,
} from "../../../src/flow/runtime/records.js";
import { replyWith, testWith } from "../../../src/testing/index.js";
import { OfferDraftDto } from "../fixtures/dtos.js";
import {
  DraftEditorAgent,
  DraftHistoryWorkflowFinish,
  FirstDraftAgent,
  HistoryOfferApplication,
  HistoryOfferWorkflow,
  HistoryOfferWorkflowStart,
  resetReviews,
  reviews,
} from "../fixtures/history.fixture.js";

/**
 * #299 AC4 (S56) at run time: `historyOf(OfferDraftDto, { limit: 2 })` on the review loop is the
 * current draft and at most the two before it, oldest first; `historyOf(OfferDraftDto)` every
 * earlier version. `previous` comes from the slot's `outdatedValues`; the input message shows it.
 */

const test = testWith(HistoryOfferApplication);

/** A version as a history holds it: who wrote it and the draft. */
const version = (producer: typeof FirstDraftAgent | typeof DraftEditorAgent, text: string) => ({
  producer,
  value: { text },
});

describe("#299 AC4: historyOf at run time", () => {
  beforeEach(resetReviews);

  test("the reviewer's history: v1 / [], v2 / [v1], v3 / [v1, v2], v4 / [v2, v3]; the finish all", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(FirstDraftAgent).thenReturn(replyWith(OfferDraftDto, { text: "v1" }));
    mockLlm(DraftEditorAgent).thenReturn(
      replyWith(OfferDraftDto, { text: "v2" }),
      replyWith(OfferDraftDto, { text: "v3" }),
      replyWith(OfferDraftDto, { text: "v4" }),
    );

    const result = await app.execute(HistoryOfferWorkflowStart, { candidates: "Ann" });

    expect(reviews.map((review) => review.draft)).toEqual([
      { current: version(FirstDraftAgent, "v1"), previous: [] },
      { current: version(DraftEditorAgent, "v2"), previous: [version(FirstDraftAgent, "v1")] },
      {
        current: version(DraftEditorAgent, "v3"),
        previous: [version(FirstDraftAgent, "v1"), version(DraftEditorAgent, "v2")],
      },
      {
        current: version(DraftEditorAgent, "v4"),
        previous: [version(DraftEditorAgent, "v2"), version(DraftEditorAgent, "v3")],
      },
    ]);
    expect(result).toFinishWith(DraftHistoryWorkflowFinish, { changes: "v1 → v2 → v3 → v4" });
  });
});

describe("#299 AC4: the input message shows the history", () => {
  const [field] =
    analyseWorkflow(HistoryOfferWorkflow).fields.get("review-draft-action" as never) ?? [];
  const record = (valueId: string, text: string): ScopeValueRecord => ({
    valueId,
    slot: "OfferDraftDto",
    producer: valueId.split(":")[0] ?? "",
    value: { text },
    builtFrom: [],
  });
  const outdated = (valueId: string, text: string): OutdatedValueRecord => ({
    ...record(valueId, text),
    outdated: { byValueId: "next", reason: OutdatedReason.Replaced },
  });

  it("the current value, then its earlier versions oldest first (at most the limit)", () => {
    if (field === undefined) throw new Error("review-draft-action has no field");
    const view = {
      scope: { OfferDraftDto: record("draft-editor-agent:3/OfferDraftDto", "v4") },
      outdatedValues: [
        outdated("first-draft-agent:1/OfferDraftDto", "v1"),
        outdated("draft-editor-agent:1/OfferDraftDto", "v2"),
        outdated("draft-editor-agent:2/OfferDraftDto", "v3"),
      ],
    };

    expect(inputMessageOf([field], view)).toBe(
      [
        "### draft (from draft-editor-agent)",
        '{\n  "text": "v4"\n}',
        "",
        "### draft, earlier versions (oldest first)",
        JSON.stringify(
          [
            { producer: "draft-editor-agent", value: { text: "v2" } },
            { producer: "draft-editor-agent", value: { text: "v3" } },
          ],
          null,
          2,
        ),
      ].join("\n"),
    );
    expect(inputMessageOf([field], { ...view, outdatedValues: [] })).toContain(
      "### draft, earlier versions (oldest first)\n[]",
    );
  });
});
