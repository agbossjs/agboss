import { Integer, Text } from "agboss/dto";

/** What a buyer wants to pay for: the question its approval is about (`approves`). */
export class PurchaseOrder {
  @Text({ prompt: "what is bought: the venue, or the flights" })
  item!: string;

  @Integer({ prompt: "the price in whole dollars", min: 1 })
  amountUsd!: number;
}

/** The placed purchase: the tool ran, so its approval was given. */
export class PurchasePlaced {
  @Text({ prompt: "what was bought" })
  item!: string;

  @Text({ prompt: "the purchase's reference" })
  reference!: string;
}
