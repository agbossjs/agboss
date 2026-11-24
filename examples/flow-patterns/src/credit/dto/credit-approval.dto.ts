import { Bool } from "@agboss/core/dto";

/** A large order's approval. */
export class CreditApprovalDto {
  @Bool({ prompt: "whether the order is approved" })
  approved!: boolean;
}
