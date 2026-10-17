import { Integer, Text } from "agboss/dto";

/** The order read from the customer's message: what the credit-limit router decides on. */
export class CreditOrderDto {
  @Text({ prompt: "the customer who orders" })
  customerId!: string;

  @Integer({ prompt: "the order's total in whole dollars" })
  total!: number;
}
