import { Text } from "@agboss/core/dto";

/** The contract the committee signs off. */
export class ContractDto {
  @Text({ prompt: "the contract's title" })
  title!: string;
}
