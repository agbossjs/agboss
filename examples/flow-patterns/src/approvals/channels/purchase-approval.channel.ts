import { PauseRespondent, ToolApproval } from "@agboss/core";
import { PurchaseOrder } from "../dto/place-purchase.dto.js";
import { days } from "@agboss/core/units";

/**
 * The role a purchase is approved through (#267): it approves `place-purchase-tool` calls and the
 * thread's owner answers them — the person who asked for the offsite. Its one implementation is
 * listed in `@Application({ providers })`: `TerminalPurchaseApprovalChannel`.
 */
@ToolApproval({
  name: "purchase-tool-approval",
  description: "The thread's owner approves a purchase",
  input: PurchaseOrder,
  respondent: PauseRespondent.Owner,
  timeout: days(365),
})
export class PurchaseToolApproval {}
