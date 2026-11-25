/**
 * #1366: the spend of a model router's launch decision — its call is in the usage the router's step hands on, so
 * the execution's record (`includeRecord: true`) states it with the agents' own.
 */
import { describe, expect } from "vitest";
import { decideWith, replyWith, testWith } from "../../../src/testing/index.js";
import { usd } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import { CustomerReplyDto, LoyaltyOfferDto, OrderStatusDto } from "../fixtures/data-dtos.js";
import { RefundPolicyDto } from "../fixtures/launch-dtos.js";
import {
  AnswerAgent,
  HelpDeskRouter,
  HelpDeskWorkflowStart,
  LoyaltyOfferAgent,
  OrderLookupAgent,
  RefundPolicyAgent,
} from "../fixtures/launch.fixture.js";
import { HelpDeskApplication } from "./fixtures/launch.applications.js";

const desk = testWith(HelpDeskApplication);

describe("#1366: the record of a run with a model router", () => {
  desk("states the launch decision's cost", async ({ app, mockModel }) => {
    mockModel(HelpDeskRouter).thenReturn(
      decideWith({ "refund-policy-agent": 0.9 }, { cost: usd(0.125) }),
    );
    mockModel(OrderLookupAgent).thenReturn(replyWith(OrderStatusDto, { status: "shipped" }));
    mockModel(RefundPolicyAgent).thenReturn(replyWith(RefundPolicyDto, { policy: "30 days" }));
    mockModel(LoyaltyOfferAgent).thenReturn(replyWith(LoyaltyOfferDto, { offer: "10% off" }));
    mockModel(AnswerAgent).thenReturn(
      replyWith(CustomerReplyDto, { text: "Here you go.", holdForReview: false }),
    );

    const result = await execute(
      app,
      HelpDeskWorkflowStart,
      { text: "can I return it?" },
      { includeRecord: true },
    );

    expect(result.spend.totalUsd).toBeCloseTo(0.125, 9);
    expect(result.record?.spend.totalUsd).toBeCloseTo(0.125, 9);
  });
});
