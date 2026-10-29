import { Flag } from "@agboss/core/dto";

/** A large order's approval. */
export class CreditApprovalDto {
  @Flag({ prompt: "whether the order is approved" })
  approved!: boolean;
}
