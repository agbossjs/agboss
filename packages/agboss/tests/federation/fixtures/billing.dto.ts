import { Integer, Text } from "../../../src/dto/index.js";

/** The DTOs of the billing desks the shop consumes (#398 PR 4). */

export class BillingQuestionDto {
  @Text({ prompt: "the question about an invoice" })
  question!: string;
}

export class BillingAnswerDto {
  @Text()
  answer!: string;
}

/** The changed contract: an invoice number required in, the answer renamed out. */
export class StrictBillingQuestionDto {
  @Text({ prompt: "the question about an invoice" })
  question!: string;

  @Integer({ prompt: "the invoice's number" })
  invoiceNumber!: number;
}

export class RenamedBillingAnswerDto {
  @Text()
  reply!: string;
}
