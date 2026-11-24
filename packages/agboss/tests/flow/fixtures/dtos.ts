import { Bool, Text } from "../../../src/dto/index.js";

/** DTOs of the #272 examples (one file for the fixtures; a project keeps one class per file). */

export class WorkflowStartTextDto {
  @Text({ prompt: "the customer's message" })
  text!: string;
}

export class ProfileDto {
  @Text({ prompt: "the candidate's profile" })
  summary!: string;
}

/** A marker: the customer sent no resume. */
export class ResumeMissingDto {
  @Text({ prompt: "why no resume was found", optional: true })
  reason?: string;
}

export class OpeningsDto {
  @Text({ prompt: "the openings found" })
  openings!: string;
}

export class ShortlistDto {
  @Text({ prompt: "the shortlisted candidates" })
  candidates!: string;
}

export class OfferDraftDto {
  @Text({ prompt: "the offer text" })
  text!: string;
}

export class ChangesRequestedDto {
  @Text({ prompt: "what to change" })
  notes!: string;
}

/** A marker: the reviewer approved the draft. */
export class DraftApprovedDto {
  @Text({ prompt: "a note for the record", optional: true })
  note?: string;
}

export class OfferSentDto {
  @Bool({ prompt: "the offer was delivered" })
  delivered!: boolean;
}

export class ArticleRequestDto {
  @Text({ prompt: "the topic" })
  topic!: string;
}

export class ArticleDto {
  @Text({ prompt: "the article" })
  body!: string;
}

export class ReviewDto {
  @Text({ prompt: "the review" })
  notes!: string;
}

export class OrderRequestDto {
  @Text({ prompt: "the order id" })
  orderId!: string;
}

export class StockReservationDto {
  @Text({ prompt: "the reservation id" })
  reservationId!: string;
}

export class OrderShippedDto {
  @Text({ prompt: "the tracking number" })
  trackingNumber!: string;
}

/** A DTO no path gives — for the negative compile-time checks. */
export class UnrelatedDto {
  @Text({ prompt: "anything" })
  anything!: string;
}
