import { describe, expect, it } from "vitest";
import { replyWith, testWith } from "@agboss/core/testing";
import { NotifyRecruiterAction } from "../../../../src/offer/actions/notify-recruiter.action.js";
import { SendOfferAction } from "../../../../src/offer/actions/send-offer.action.js";
import { DraftAgent } from "../../../../src/offer/agents/draft/draft.agent.js";
import { EditorAgent } from "../../../../src/offer/agents/editor/editor.agent.js";
import { ReviewerAgent } from "../../../../src/offer/agents/reviewer/reviewer.agent.js";
import { ChangesRequestedDto } from "../../../../src/offer/dto/changes-requested.dto.js";
import { DraftApprovedDto } from "../../../../src/offer/dto/draft-approved.dto.js";
import { OfferDraftDto } from "../../../../src/offer/dto/offer-draft.dto.js";
import { FlowPatternsApplication } from "../../../../src/flow-patterns.application.js";
import { OfferMailer } from "../../../../src/offer/services/offer-mailer.service.js";
import { RecruiterInbox } from "../../../../src/offer/services/recruiter-inbox.service.js";
import { OfferFailedWorkflowFinish } from "../../../../src/offer/workflows/offer/offer-failed.workflow-finish.js";
import { OfferSentWorkflowFinish } from "../../../../src/offer/workflows/offer/offer-sent.workflow-finish.js";
import { OfferWorkflowStart } from "../../../../src/offer/workflows/offer/offer.workflow-start.js";

/** The review loop: draft → reviewer, reviewer → editor → reviewer until it approves. */

const test = testWith(FlowPatternsApplication);

const draft = (text: string) => replyWith(OfferDraftDto, { text });
const changes = (notes: string) => replyWith(ChangesRequestedDto, { notes });
const shortlist = { candidates: "Ada Lovelace, Alan Turing" };

describe("the review loop", () => {
  test("changes requested → editor → reviewer → approved → the offer is sent", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(DraftAgent).thenReturn(draft("v1: Ada, engineer"));
    mockLlm(ReviewerAgent).thenReturn(
      changes("add the salary"),
      replyWith(DraftApprovedDto, { note: "good to go" }),
    );
    mockLlm(EditorAgent).thenReturn(draft("v2: Ada, engineer, $150k"));

    const result = await app.execute(OfferWorkflowStart, shortlist);

    expect(result).toFollowPath([
      OfferWorkflowStart,
      DraftAgent,
      ReviewerAgent,
      EditorAgent,
      ReviewerAgent,
      SendOfferAction,
      OfferSentWorkflowFinish,
    ]);
    expect(result).toFinishWith(OfferSentWorkflowFinish, { delivered: true });
    // the editor reads the draft and the notes; the reviewer the latest draft and the one before
    // (historyOf: { current, previous })
    expect(mockLlm(EditorAgent).lastRequest.input).toContain("add the salary");
    const [first, second] = mockLlm(ReviewerAgent).inputs;
    expect(first?.draft).toMatchObject({ current: { value: { text: "v1: Ada, engineer" } } });
    expect(second?.draft).toMatchObject({
      current: { value: { text: "v2: Ada, engineer, $150k" } },
      previous: [{ value: { text: "v1: Ada, engineer" } }],
    });
  });

  test("approved at once: the draft is sent as it is", async ({ app, mockLlm, mockOf }) => {
    mockOf(OfferMailer).send.mockResolvedValue(true);
    mockLlm(DraftAgent).thenReturn(draft("v1"));
    mockLlm(ReviewerAgent).thenReturn(replyWith(DraftApprovedDto, {}));

    const result = await app.execute(OfferWorkflowStart, shortlist);

    expect(result.path).not.toContain("editor-agent");
    expect(mockOf(OfferMailer).send.mock.calls).toEqual([["v1"]]);
  });
});

describe("the editor's maxVisits spent", () => {
  test("VisitsLimitExceededError → .onError → notify the recruiter → the failed finish", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    mockOf(RecruiterInbox).notify.mockResolvedValue(true);
    mockLlm(DraftAgent).thenReturn(draft("v1"));
    mockLlm(ReviewerAgent).thenReturnAlways(changes("still not right"));
    mockLlm(EditorAgent).thenReturn(draft("v2"), draft("v3"));

    const result = await app.execute(OfferWorkflowStart, shortlist, { record: true });

    expect(result).toFollowPath([
      OfferWorkflowStart,
      DraftAgent,
      ReviewerAgent,
      EditorAgent,
      ReviewerAgent,
      EditorAgent,
      ReviewerAgent,
      EditorAgent, // the third visit: refused before the model call, taken by .onError
      NotifyRecruiterAction,
      OfferFailedWorkflowFinish,
    ]);
    expect(result).toFinishWith(OfferFailedWorkflowFinish, { text: "v3" });
    expect(result.record?.lastError).toMatchObject({ code: "limit.visits" });
    expect(mockLlm(EditorAgent).requests).toHaveLength(2);
    expect(mockOf(RecruiterInbox).notify.mock.calls).toEqual([["The offer was not approved: v3"]]);
  });
});

describe("the services", () => {
  it("the services are real when not mocked", async () => {
    await expect(new RecruiterInbox().notify("a note")).resolves.toBe(true);
    await expect(new OfferMailer().send("")).resolves.toBe(false);
  });
});
