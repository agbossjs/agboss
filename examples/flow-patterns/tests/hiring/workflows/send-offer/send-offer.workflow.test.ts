import { expect } from "vitest";
import {
  BudgetExceededError,
  ChannelOutcome,
  CompensationFailedError,
  CompensationReason,
  CompensationStatus,
  StepFailedError,
} from "@agboss/core";
import { callTool, failWith, ModelFailure, replyWith, testWith } from "@agboss/core/testing";
import { usd } from "@agboss/core/units";
import { AlertRecruiterAction } from "../../../../src/hiring/actions/alert-recruiter.action.js";
import { BookOnboardingSlotAction } from "../../../../src/hiring/actions/book-onboarding-slot.action.js";
import { ConfirmOfferAction } from "../../../../src/hiring/actions/confirm-offer.action.js";
import { RegisterOfferAction } from "../../../../src/hiring/actions/register-offer.action.js";
import { ReleaseOnboardingSlotAction } from "../../../../src/hiring/actions/release-onboarding-slot.action.js";
import { WithdrawOfferAction } from "../../../../src/hiring/actions/withdraw-offer.action.js";
import { OfferLetterAgent } from "../../../../src/hiring/agents/offer-letter/offer-letter.agent.js";
import { OfferSenderAgent } from "../../../../src/hiring/agents/offer-sender/offer-sender.agent.js";
import { RecruiterInboxChannel } from "../../../../src/hiring/channels/recruiter-inbox.channel.js";
import { OfferLetterDto, OfferLetterSentDto } from "../../../../src/hiring/dto/offer.dto.js";
import {
  AtsClientService,
  AtsUnavailableError,
} from "../../../../src/hiring/services/ats-client.service.js";
import {
  CalendarUnavailableError,
  HrCalendarService,
} from "../../../../src/hiring/services/hr-calendar.service.js";
import { ExecutionBudget } from "../../../../src/config/budget.config.js";
import { RecruiterDeskService } from "../../../../src/hiring/services/recruiter-desk.service.js";
import { SendOfferLetterTool } from "../../../../src/hiring/tools/send-offer-letter.tool.js";
import { OfferConfirmedWorkflowFinish } from "../../../../src/hiring/workflows/send-offer/offer-confirmed.workflow-finish.js";
import { OfferWithdrawnWorkflowFinish } from "../../../../src/hiring/workflows/send-offer/offer-withdrawn.workflow-finish.js";
import { SendOfferWorkflowStart } from "../../../../src/hiring/workflows/send-offer/send-offer.workflow-start.js";
import { FlowPatternsApplication } from "../../../../src/flow-patterns.application.js";

/**
 * Declared compensation (#339 AC3): the send-offer workflow's undoable steps, its commit point and
 * the side path that undoes both, newest first, each undo in `result.compensations`
 * (`CompensationReason.SidePath`); a failure, a limit or a cancel no path takes is undone
 * automatically, newest first, before the execution ends (#340 PR 3).
 * `agboss check --strict` (`npm run check`) proves the side path complete.
 */

const test = testWith(FlowPatternsApplication);

const REQUEST = { candidateId: "ada", role: "SRE" };

test("happy path: confirm commits both actions, nothing is undone", async ({
  app,
  mockLlm,
  mockOf,
  mockAction,
}) => {
  mockOf(AtsClientService).registerOffer.mockResolvedValue("offer-7");
  mockOf(HrCalendarService).bookSlot.mockResolvedValue("slot-3");
  mockOf(RecruiterInboxChannel).send.mockResolvedValue(ChannelOutcome.decided({ approved: true }));
  mockLlm(OfferLetterAgent).thenReturn(replyWith(OfferLetterDto, { text: "Dear Ada…" }));
  mockLlm(OfferSenderAgent).thenReturn(
    callTool(SendOfferLetterTool, { text: "Dear Ada…" }),
    replyWith(OfferLetterSentDto, { messageId: "m-1" }),
  );

  const result = await app.execute(SendOfferWorkflowStart, REQUEST);

  expect(result).toFollowPath([
    SendOfferWorkflowStart,
    RegisterOfferAction,
    BookOnboardingSlotAction,
    OfferLetterAgent,
    OfferSenderAgent,
    ConfirmOfferAction,
    OfferConfirmedWorkflowFinish,
  ]);
  expect(result).toFinishWith(OfferConfirmedWorkflowFinish, { offerId: "offer-7" });
  expect(result.compensations).toEqual([]);
  expect(mockAction(WithdrawOfferAction)).toHaveBeenCalledTimes(0);
});

test("a handled failure: the side path undoes both, newest first", async ({
  app,
  mockLlm,
  mockOf,
}) => {
  const ats = mockOf(AtsClientService);
  const calendar = mockOf(HrCalendarService);
  ats.registerOffer.mockResolvedValue("offer-7");
  calendar.bookSlot.mockResolvedValue("slot-3");
  mockLlm(OfferLetterAgent).thenReturn(failWith(ModelFailure.Timeout));

  const result = await app.execute(SendOfferWorkflowStart, REQUEST);

  expect(result).toFollowPath([
    SendOfferWorkflowStart,
    RegisterOfferAction,
    BookOnboardingSlotAction,
    OfferLetterAgent,
    ReleaseOnboardingSlotAction,
    WithdrawOfferAction,
    OfferWithdrawnWorkflowFinish,
  ]);
  expect(result).toFinishWith(OfferWithdrawnWorkflowFinish, REQUEST);
  expect(calendar.releaseSlot.mock.calls[0]?.[0]).toBe("slot-3");
  expect(ats.withdrawOffer.mock.calls[0]?.[0]).toBe("offer-7");
  const [released] = calendar.releaseSlot.mock.invocationCallOrder;
  const [withdrawn] = ats.withdrawOffer.mock.invocationCallOrder;
  expect(released).toBeLessThan(withdrawn ?? 0);
  expect(result).toHaveCompensated(BookOnboardingSlotAction, {
    by: ReleaseOnboardingSlotAction,
    reason: CompensationReason.SidePath,
  });
  expect(result).toHaveCompensated(RegisterOfferAction, {
    by: WithdrawOfferAction,
    reason: CompensationReason.SidePath,
  });
});

test("an undo that fails: its own side path hands the offer to a person", async ({
  app,
  mockLlm,
  mockOf,
}) => {
  const ats = mockOf(AtsClientService);
  ats.registerOffer.mockResolvedValue("offer-7");
  ats.withdrawOffer.mockRejectedValue(new AtsUnavailableError("ATS answered 503"));
  mockOf(HrCalendarService).bookSlot.mockResolvedValue("slot-3");
  const desk = mockOf(RecruiterDeskService);
  mockLlm(OfferLetterAgent).thenReturn(failWith(ModelFailure.Timeout));

  const result = await app.execute(SendOfferWorkflowStart, REQUEST);

  expect(result).toFollowPath([
    SendOfferWorkflowStart,
    RegisterOfferAction,
    BookOnboardingSlotAction,
    OfferLetterAgent,
    ReleaseOnboardingSlotAction,
    WithdrawOfferAction,
    AlertRecruiterAction,
    OfferWithdrawnWorkflowFinish,
  ]);
  expect(result).toHaveCompensated(RegisterOfferAction, {
    by: WithdrawOfferAction,
    status: CompensationStatus.Failed,
  });
  expect(desk.alert.mock.calls).toEqual([
    ["Offer offer-7 could not be withdrawn: withdraw it by hand"],
  ]);
});

test("an uncaught failure: undone automatically, newest first, then the run fails", async ({
  app,
  mockLlm,
  mockOf,
}) => {
  mockOf(AtsClientService).registerOffer.mockResolvedValue("offer-7");
  mockOf(HrCalendarService).bookSlot.mockResolvedValue("slot-3");
  mockLlm(OfferLetterAgent).thenReturn(replyWith(OfferLetterDto, { text: "Dear Ada…" }));
  mockLlm(OfferSenderAgent).thenReturn(failWith(ModelFailure.Timeout));

  const run = app.execute(SendOfferWorkflowStart, REQUEST);

  await expect(run).rejects.toFailWith(StepFailedError);
  const [released] = mockOf(HrCalendarService).releaseSlot.mock.invocationCallOrder;
  const [withdrawn] = mockOf(AtsClientService).withdrawOffer.mock.invocationCallOrder;
  expect(released).toBeLessThan(withdrawn ?? 0);
});

test("an undo that fails: the rest still runs, the run fails with CompensationFailedError", async ({
  app,
  mockLlm,
  mockOf,
}) => {
  mockOf(AtsClientService).registerOffer.mockResolvedValue("offer-7");
  mockOf(HrCalendarService).bookSlot.mockResolvedValue("slot-3");
  mockOf(HrCalendarService).releaseSlot.mockRejectedValue(new CalendarUnavailableError("down"));
  mockLlm(OfferLetterAgent).thenReturn(replyWith(OfferLetterDto, { text: "Dear Ada…" }));
  mockLlm(OfferSenderAgent).thenReturn(failWith(ModelFailure.Timeout));

  const run = app.execute(SendOfferWorkflowStart, REQUEST);

  await expect(run).rejects.toFailWith(CompensationFailedError, {
    failures: [
      expect.objectContaining({
        compensated: expect.objectContaining({
          component: expect.objectContaining({ name: "book-onboarding-slot-action" }) as unknown,
        }) as unknown,
        status: CompensationStatus.Failed,
        reason: CompensationReason.ExecutionFailed,
      }) as unknown,
    ],
    cause: StepFailedError,
  });
  expect(mockOf(AtsClientService).withdrawOffer.mock.calls).toHaveLength(1); // the older one still undone
});

test("a cancel while paused: the pause is withdrawn, both undone, then cancelled", async ({
  app,
  mockLlm,
  mockOf,
}) => {
  mockOf(AtsClientService).registerOffer.mockResolvedValue("offer-7");
  mockOf(HrCalendarService).bookSlot.mockResolvedValue("slot-3");
  mockLlm(OfferLetterAgent).thenReturn(replyWith(OfferLetterDto, { text: "Dear Ada…" }));
  mockLlm(OfferSenderAgent).thenReturn(callTool(SendOfferLetterTool, { text: "Dear Ada…" }));
  const paused = await app.execute(SendOfferWorkflowStart, REQUEST, { threadId: "t-1" });
  expect(paused.pending).toHaveLength(1);

  const cancel = await app.cancel(paused.threadId); // waits for the undo, each bounded by compensationTimeout

  expect(cancel).toEqual({ cancelled: true });
  expect(mockOf(HrCalendarService).releaseSlot.mock.calls).toHaveLength(1);
  expect(mockOf(AtsClientService).withdrawOffer.mock.calls).toHaveLength(1);
});

test("an exhausted budget: no model call after it, both undone, then BudgetExceededError", async ({
  app,
  mockLlm,
  mockOf,
}) => {
  mockOf(ExecutionBudget).maxSpend.mockReturnValue(usd(0.01));
  mockOf(AtsClientService).registerOffer.mockResolvedValue("offer-7");
  mockOf(HrCalendarService).bookSlot.mockResolvedValue("slot-3");
  mockLlm(OfferLetterAgent).thenReturn(
    replyWith(OfferLetterDto, { text: "Dear Ada…" }, { cost: usd(0.02) }),
  );

  const run = app.execute(SendOfferWorkflowStart, REQUEST);

  await expect(run).rejects.toFailWith(BudgetExceededError, {
    budget: expect.objectContaining({ name: "execution-budget" }) as unknown,
  });
  expect(mockOf(HrCalendarService).releaseSlot.mock.calls).toHaveLength(1);
  expect(mockOf(AtsClientService).withdrawOffer.mock.calls).toHaveLength(1);
});
