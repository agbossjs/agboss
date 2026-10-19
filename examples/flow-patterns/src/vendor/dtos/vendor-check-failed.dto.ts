import { Text } from "agboss/dto";

/** A vendor whose check failed: the child's soft failure, one more class for its parent. */
export class VendorCheckFailedDto {
  @Text({ prompt: "the vendor's name" })
  name!: string;

  @Text({ prompt: "why the check failed" })
  reason!: string;
}
