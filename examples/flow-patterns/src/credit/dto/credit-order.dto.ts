import { Integer, Text } from "@agboss/core/dto";

/** The order read from the customer's message: what the credit-limit router decides on. */
export class CreditOrderDto {
  @Text({ prompt: "the credit application's reference, as the message states it" })
  applicationId!: string;

  @Text({ prompt: "the customer who orders" })
  customerId!: string;

  @Integer({ prompt: "the order's total in whole dollars" })
  total!: number;
}
