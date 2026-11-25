import { Text } from "@agboss/core/dto";

/** What the workflow gives once the committee has signed. */
export class SignedContractDto {
  @Text({ prompt: "the signed contract's title" })
  title!: string;

  @Text({ prompt: "how many parties signed" })
  signedBy!: string;
}
