import {
  ToolCallDecision,
  ToolInterceptor,
  nameOf,
  type AfterToolCall,
  type BeforeToolCall,
  type ToolCallContext,
  type ToolCallResultContext,
} from "agboss";
import { CloseAccountTool } from "../tools/close-account.tool.js";
import { OrderStatusTool } from "../tools/order-status.tool.js";

/** An archived order's id starts with `A-`: the desk does not look those up. */
const ARCHIVED_PREFIX = "A-";

const orderIdOf = (input: unknown): string | undefined =>
  typeof input === "object" &&
  input !== null &&
  "orderId" in input &&
  typeof input.orderId === "string"
    ? input.orderId
    : undefined;

const statusOf = (output: unknown): string | undefined =>
  typeof output === "object" &&
  output !== null &&
  "status" in output &&
  typeof output.status === "string"
    ? output.status
    : undefined;

/**
 * Around every tool call of the desk's agent (#384), in code: an account is never closed from the
 * desk (`block` — the step fails with `ToolBlockedError`); an archived order is not looked up — the
 * model reads why and goes on (`replyToModel`); a status loses its internal note before the model
 * reads it (`afterToolCall`).
 */
@ToolInterceptor({
  name: "desk-audit-tool-interceptor",
  description: "Blocks account closures, skips archived orders, cuts internal notes",
})
export class DeskAuditToolInterceptor implements BeforeToolCall, AfterToolCall {
  beforeToolCall(call: ToolCallContext): ToolCallDecision {
    if (call.tool.name === nameOf(CloseAccountTool))
      return ToolCallDecision.block({ reason: "accounts are closed by the back office only" });
    const orderId = orderIdOf(call.input);
    if (orderId?.startsWith(ARCHIVED_PREFIX) === true)
      return ToolCallDecision.replyToModel({
        message: `Order ${orderId} is archived: ask the customer for a recent one.`,
      });
    return ToolCallDecision.allow();
  }

  afterToolCall(call: ToolCallResultContext): unknown {
    const status = statusOf(call.output);
    if (call.tool.name !== nameOf(OrderStatusTool) || status === undefined) return call.output;
    return { status: status.split("|")[0]?.trim() ?? status };
  }
}
