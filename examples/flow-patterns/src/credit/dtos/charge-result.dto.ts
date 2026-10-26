import { Text } from "@agboss/core/dto";

/** The card charge for the order. */
export class ChargeResultDto {
  @Text({ prompt: "the charge's id" })
  chargeId!: string;
}
