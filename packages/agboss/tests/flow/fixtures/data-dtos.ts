import { Bool, List, Text } from "../../../src/dto/index.js";

/** DTOs of the #270 examples (the support desk, the tagged drafts). */

export class OrderStatusDto {
  @Text({ prompt: "where the order is now" })
  status!: string;
}

export class FastDraftDto {
  @Text({ prompt: "the reply text" })
  text!: string;
}

export class LoyaltyOfferDto {
  @Text({ prompt: "the offer for a loyal customer" })
  offer!: string;
}

export class ExpertDraftDto {
  @Text({ prompt: "the reply text" })
  text!: string;

  @Bool({ prompt: "a human should double-check before sending" })
  needsHumanCheck!: boolean;

  @List(Text, { prompt: "the policies the reply relies on" })
  citedPolicies!: string[];
}

export class CustomerReplyDto {
  @Text({ prompt: "the reply to send" })
  text!: string;

  @Bool({ prompt: "hold for a human before sending" })
  holdForReview!: boolean;
}

export class DraftChangesDto {
  @Text({ prompt: "what the editor changed" })
  changes!: string;
}

export class CompanyDto {
  @Text({ prompt: "the company's name" })
  name!: string;
}

export class SearchRequestDto {
  @Text({ prompt: "what the search looks for" })
  criteria!: string;
}

export class CompanyScoreDto {
  @Text({ prompt: "how well the company fits" })
  score!: string;
}
