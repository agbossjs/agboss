import { AfterTool, BeforeTool, ToolCallDecision, ToolInterceptor } from "@agboss/core";
import { OrderLookupDto, OrderStatusDto } from "../dto/order-lookup.dto.js";
import { CloseAccountTool } from "../tools/close-account.tool.js";
import { OrderStatusTool } from "../tools/order-status.tool.js";

/** An archived order's id starts with `A-`: the desk does not look those up. */
const ARCHIVED_PREFIX = "A-";

/**
 * Around the desk's tool calls (#384, #1295), in code, one method per tool: an account is never
 * closed from the desk (`block` — the step fails with `StepError.ToolBlocked`); an archived order is not
 * looked up — the model reads why and goes on (`reply`); a status loses its internal note before the
 * model reads it.
 */
@ToolInterceptor({
  name: "desk-audit-tool-interceptor",
  description: "Blocks account closures, skips archived orders, cuts internal notes",
})
export class DeskAuditToolInterceptor {
  @BeforeTool(CloseAccountTool)
  blockAccountClosure(): ToolCallDecision {
    return ToolCallDecision.block("accounts are closed by the back office only");
  }

  @BeforeTool(OrderStatusTool)
  skipArchivedOrder({ orderId }: OrderLookupDto): ToolCallDecision {
    if (orderId.startsWith(ARCHIVED_PREFIX))
      return ToolCallDecision.reply(
        `Order ${orderId} is archived: ask the customer for a recent one.`,
      );
    return ToolCallDecision.allow();
  }

  @AfterTool(OrderStatusTool)
  stripInternalNote({ status }: OrderStatusDto): OrderStatusDto {
    return { status: status.split("|")[0]?.trim() ?? status };
  }
}
