/**
 * #262 PR 2 — `mockAction(A)` (AC9): the action still runs; its calls are recorded — what it
 * received (an error handler's input too) and what it returned — with the call matchers of
 * `mockLlm`.
 */
import { describe, expect } from "vitest";
import { TestSetupError, testWith } from "../../src/testing/index.js";
import {
  ChangesRequestedDto,
  DraftApprovedDto,
  OfferDraftDto,
  StockReservationDto,
} from "../flow/fixtures/dtos.js";
import {
  DraftEditorAgent,
  FirstDraftAgent,
  HistoryOfferApplication,
  HistoryOfferWorkflowStart,
  ReviewDraftAction,
} from "../flow/fixtures/history.fixture.js";
import {
  CarrierError,
  OrderFailedWorkflowFinish,
  OrderWorkflowFinish,
  OrderWorkflowStart,
  RefundCardAction,
  ReleaseStockAction,
  ReserveStockAction,
  ShipOrderAction,
} from "../flow/fixtures/order.fixture.js";
import { replyWith } from "../../src/testing/index.js";
import { OrderApplication } from "./fixtures/order.application.js";

const orders = testWith(OrderApplication);
const offers = testWith(HistoryOfferApplication);

const draft = (text: string) => replyWith(OfferDraftDto, { text });

describe("AC9: mockAction(A) runs the real action and records its calls", () => {
  orders("what an action received and returned", async ({ app, mockAction }) => {
    const result = await app.execute(OrderWorkflowStart, { orderId: "7" });

    expect(result).toFinishWith(OrderWorkflowFinish, { trackingNumber: "track-7" });
    expect(mockAction(ReserveStockAction).inputs).toMatchObject([
      { order: { value: { orderId: "7" } } },
    ]);
    expect(mockAction(ReserveStockAction)).toHaveBeenCalledWith({ order: { orderId: "7" } });
    expect(mockAction(ReserveStockAction)).toHaveBeenCalledTimes(1);
    expect(mockAction(ReserveStockAction)).toHaveReturned(StockReservationDto, {
      reservationId: "reservation-7",
    });
    expect(mockAction(RefundCardAction)).toHaveBeenCalledTimes(0);
  });

  orders(
    "what an error handler received: the carrier failed, the refund and the release ran",
    async ({ app, mockAction, mockOf }) => {
      mockOf(ShipOrderAction).execute.mockRejectedValue(new CarrierError("the carrier is down"));

      const result = await app.execute(OrderWorkflowStart, { orderId: "8" });

      expect(result).toFinishWith(OrderFailedWorkflowFinish, { orderId: "8" });
      expect(mockAction(RefundCardAction)).toHaveBeenCalledWith({ order: { orderId: "8" } });
      expect(mockAction(ReleaseStockAction)).toHaveBeenCalledWith({
        reservation: { reservationId: "reservation-8" },
      });
    },
  );

  offers(
    "a oneOf result is named by its variant; a historyOf input by its versions",
    async ({ app, mockAction, mockLlm }) => {
      mockLlm(FirstDraftAgent).thenReturn(draft("v1"));
      mockLlm(DraftEditorAgent).thenReturn(draft("v2"), draft("v3"), draft("v4"));

      await app.execute(HistoryOfferWorkflowStart, { candidates: "Dana" });

      expect(mockAction(ReviewDraftAction)).toHaveBeenCalledTimes(4);
      expect(mockAction(ReviewDraftAction)).toHaveBeenCalledWith({
        draft: { current: { text: "v4" }, previous: [{ text: "v2" }, { text: "v3" }] },
      });
      expect(mockAction(ReviewDraftAction)).toHaveReturned(ChangesRequestedDto, {
        notes: "after 0 versions",
      });
      expect(mockAction(ReviewDraftAction)).toHaveReturned(DraftApprovedDto);
    },
  );

  orders("mockAction of a class that is not an action fails the setup", ({ mockAction }) => {
    expect(() => mockAction(OrderWorkflowStart)).toThrow(TestSetupError);
    expect(() => mockAction(OrderWorkflowStart)).toThrow(
      "mockAction(OrderWorkflowStart): not an action of this application",
    );
  });
});
