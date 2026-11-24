import { ExecutionContext, Tool } from "@agboss/core";
import { PurchaseToolApproval } from "../channels/purchase-approval.channel.js";
import { PurchaseOrder, PurchasePlaced } from "../dto/place-purchase.dto.js";

/**
 * Places a purchase — only once it is approved: every call waits for the thread's owner through
 * `PurchaseToolApproval`. Its reference is the call's idempotency key, the one a real payment
 * service would get, so a repeated call is one purchase.
 */
@Tool({
  name: "place-purchase-tool",
  description: "Places a purchase once the thread's owner approves it",
  input: PurchaseOrder,
  output: PurchasePlaced,
  approval: PurchaseToolApproval,
  deps: [ExecutionContext],
})
export class PlacePurchaseTool {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute({ item }: PurchaseOrder): Promise<PurchasePlaced> {
    return Promise.resolve({ item, reference: this.executionContext.step.idempotencyKey });
  }
}
