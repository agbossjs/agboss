import { Flag, Integer, Text } from "../../../src/dto/index.js";

/**
 * DTOs of the #273 examples (with `PlanDto`, `ResearchDto`, `CritiqueDto` of `review-dtos.ts` and
 * `CompanyDto`, `OrderStatusDto`, `LoyaltyOfferDto`, `CustomerReplyDto` of `data-dtos.ts`).
 */

export class ArticleDraftDto {
  @Text({ prompt: "the article" })
  text!: string;
}

export class CompanyCheckDto {
  @Text({ prompt: "the company checked" })
  name!: string;

  @Flag({ prompt: "whether the company passed the check" })
  passed!: boolean;
}

export class RankingDto {
  @Text({ prompt: "the companies, best first" })
  order!: string;
}

export class ScreeningFailedDto {
  @Text({ prompt: "why the screening stopped" })
  reason!: string;
}

export class PaymentDto {
  @Text({ prompt: "the payment's id" })
  paymentId!: string;

  @Integer({ prompt: "the amount in whole dollars" })
  amount!: number;
}

export class RefundPolicyDto {
  @Text({ prompt: "what the refund policy says" })
  policy!: string;
}

