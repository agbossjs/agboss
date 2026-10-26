import { Integer, Text } from "@agboss/core/dto";

/** A vendor worth considering, scored. */
export class VendorScoreDto {
  @Text({ prompt: "the vendor's name" })
  name!: string;

  @Integer({ prompt: "how well it fits, from 1 to 10" })
  score!: number;
}
