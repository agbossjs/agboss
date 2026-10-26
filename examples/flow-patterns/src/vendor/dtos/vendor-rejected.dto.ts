import { Text } from "@agboss/core/dto";

/** A vendor that is not a fit. */
export class VendorRejectedDto {
  @Text({ prompt: "the vendor's name" })
  name!: string;

  @Text({ prompt: "why it is not a fit" })
  reason!: string;
}
