import { Text } from "agboss/dto";

/** One vendor to check: what the screening's finder lists, the item of each child execution. */
export class VendorDto {
  @Text({ prompt: "the vendor's name" })
  name!: string;
}
