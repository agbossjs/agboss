import { Flag, Text } from "@agboss/core/dto";

/** What `close-account-tool` takes — a call the desk's interceptor never lets through. */
export class AccountClosureDto {
  @Text({ prompt: "the customer whose account to close" })
  customerId!: string;
}

/** What `close-account-tool` would give. */
export class AccountClosedDto {
  @Flag({ prompt: "whether the account was closed" })
  closed!: boolean;
}
