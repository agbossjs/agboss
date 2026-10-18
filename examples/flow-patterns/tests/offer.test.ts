import { describe, expect, it } from "vitest";
import { describeWorkflow } from "agboss";
import { replyWith, testWith, workflowOf } from "agboss/testing";
import { NotifyRecruiterAction } from "../src/offer/actions/notify-recruiter.action.js";
import { SendOfferAction } from "../src/offer/actions/send-offer.action.js";
import { DraftAgent } from "../src/offer/agents/draft.agent.js";
import { EditorAgent } from "../src/offer/agents/editor.agent.js";
import { ReviewerAgent } from "../src/offer/agents/reviewer.agent.js";
import { ChangesRequestedDto } from "../src/offer/dtos/changes-requested.dto.js";
import { DraftApprovedDto } from "../src/offer/dtos/draft-approved.dto.js";
import { OfferDraftDto } from "../src/offer/dtos/offer-draft.dto.js";
import { OfferWorkflow } from "../src/offer/offer.workflow.js";
import { FlowPatternsApplication } from "../src/flow-patterns.application.js";
import { OfferMailer } from "../src/offer/services/offer-mailer.service.js";
import { RecruiterInbox } from "../src/offer/services/recruiter-inbox.service.js";
import { OfferFailedWorkflowFinish } from "../src/offer/workflow-finishes/offer-failed.workflow-finish.js";
import { OfferSentWorkflowFinish } from "../src/offer/workflow-finishes/offer-sent.workflow-finish.js";
import { OfferWorkflowStart } from "../src/offer/workflow-starts/offer.workflow-start.js";

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
    // the editor reads the draft and the notes; the reviewer the latest draft
    expect(mockLlm(EditorAgent).lastRequest.input).toContain("add the salary");
    expect(mockLlm(ReviewerAgent).lastRequest.input).toContain("v2: Ada, engineer, $150k");
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

describe("describe", () => {
  it("prints both paths and the reviewer's inputs by their producers' names", async () => {
    const lines = describeWorkflow(await workflowOf(OfferWorkflow));

    expect(lines).toEqual(
      expect.arrayContaining([
        "  start(OfferWorkflowStart)",
        "  agent(ReviewerAgent)",
        "  reviewer-agent ← draft: draft-agent | editor-agent (latest)",
        "  reviewer-agent → about OfferDraftDto: oneOf(ChangesRequestedDto, DraftApprovedDto)",
      ]),
    );
  });

  it("the services are real when not mocked", async () => {
    await expect(new RecruiterInbox().notify("a note")).resolves.toBe(true);
    await expect(new OfferMailer().send("")).resolves.toBe(false);
  });
});
