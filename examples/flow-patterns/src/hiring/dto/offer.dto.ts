import { Text } from "@agboss/core/dto";

/** The data on the send-offer path (#339): the request, then what each step returned. */

export class OfferRequestDto {
  @Text({ prompt: "the candidate's id" })
  candidateId!: string;

  @Text({ prompt: "the role offered" })
  role!: string;
}

export class RegisteredOfferDto {
  @Text({ prompt: "the offer's id in the ATS" })
  offerId!: string;
}

export class OnboardingSlotDto {
  @Text({ prompt: "the onboarding slot's id in the HR calendar" })
  slotId!: string;
}

export class OfferLetterDto {
  @Text({ prompt: "the offer letter" })
  text!: string;
}

export class OfferLetterSentDto {
  @Text({ prompt: "the id of the sent letter" })
  messageId!: string;
}

export class OfferConfirmedDto {
  @Text({ prompt: "the confirmed offer's id" })
  offerId!: string;
}
