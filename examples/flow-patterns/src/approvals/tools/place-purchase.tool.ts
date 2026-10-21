import { ExecutionContext, Tool, type ToolHandler } from "agboss";
import { PurchaseApprovalChannel } from "../channels/purchase-approval.channel.js";
import { PurchaseOrder, PurchasePlaced } from "./place-purchase.dto.js";

/**
 * Places a purchase — only once it is approved: every call waits for the thread's owner through
 * `PurchaseApprovalChannel`. Its reference is the call's idempotency key, the one a real payment
 * service would get, so a repeated call is one purchase.
 */
@Tool({
  name: "place_purchase",
  description: "Places a purchase once the thread's owner approves it",
  input: PurchaseOrder,
  output: PurchasePlaced,
  channel: PurchaseApprovalChannel,
  deps: [ExecutionContext],
})
export class PlacePurchaseTool implements ToolHandler<PurchaseOrder, PurchasePlaced> {
  constructor(private readonly executionContext: ExecutionContext) {}

  run({ item }: PurchaseOrder): Promise<PurchasePlaced> {
    return Promise.resolve({ item, reference: this.executionContext.step.idempotencyKey });
  }
}
