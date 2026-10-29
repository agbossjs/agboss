import { ChannelOf, ChannelRole, PauseAnswerer } from "@agboss/core";
import { PurchaseOrder } from "../dto/place-purchase.dto.js";

/**
 * The role a purchase is approved through (#267): it approves `place-purchase-tool` calls and the
 * thread's owner answers them — the person who asked for the offsite. Its one implementation is
 * listed in `@Application({ providers })`: `TerminalPurchaseApprovalChannel`.
 */
@ChannelRole({
  name: "purchase-approval-channel",
  description: "The thread's owner approves a purchase",
  approves: PurchaseOrder,
  answeredBy: PauseAnswerer.ThreadOwner,
})
export abstract class PurchaseApprovalChannel extends ChannelOf<PurchaseApprovalChannel> {}
