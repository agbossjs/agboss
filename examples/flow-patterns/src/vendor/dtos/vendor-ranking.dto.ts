import { Text } from "agboss/dto";

/** The vendors, best first, and the ones left out. */
export class VendorRankingDto {
  @Text({ prompt: "the scored vendors, best first" })
  order!: string;

  @Text({ prompt: "the vendors left out and why" })
  leftOut!: string;
}
