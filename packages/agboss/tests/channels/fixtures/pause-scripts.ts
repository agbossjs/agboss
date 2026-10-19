import type { ResumeRequest } from "../../../src/app/types.js";
import {
  callTool,
  replyWith,
  type ModelRequest,
  type ScriptedTurn,
} from "../../../src/testing/index.js";
import { RefundDoneDto, RefundTool, seen, type SentAsk } from "./pauses.workflow.js";

/** The decisions and credentials the #267 tests answer with. */
export const approve = { approved: true };
export const manager = { answeredBy: "manager-17" };

/** The order a model request is about, by its input message. */
export function orderOf(request: ModelRequest): string {
  const input = typeof request.input === "string" ? request.input : JSON.stringify(request.input);
  return /"orderId": "([^"]+)"/.exec(input)?.[1] ?? "?";
}

/** Whether the request already carries the tool's answer (the agent's second turn). */
const isAnswered = (request: ModelRequest): boolean =>
  request.kind === "chat" && request.messages.some((line) => line.role === "tool");

/** A refund agent's script: the `pausing` orders call the refund tool first; the rest reply at once. */
export const refunder =
  (pausing: readonly string[]): ((request: ModelRequest) => ScriptedTurn) =>
  (request) => {
    const orderId = orderOf(request);
    return pausing.includes(orderId) && !isAnswered(request)
      ? callTool(RefundTool, { orderId })
      : replyWith(RefundDoneDto, { orderId });
  };

/** The refund desk's ask about an order. */
export function askFor(orderId: string): SentAsk {
  const ask = seen.asks.find((sent) => sent.orderId === orderId);
  if (ask === undefined) throw new Error(`the desk was not asked about ${orderId}`);
  return ask;
}

/** The answer to the desk's ask about an order (its `pauseId` is the reply key). */
export const answerFor = (orderId: string, decision: unknown = approve): ResumeRequest => ({
  pauseId: askFor(orderId).pauseId,
  decision,
});

/** Waits (event-loop turns, no time) until `check` holds. */
export async function until(check: () => Promise<boolean> | boolean): Promise<void> {
  for (let tick = 0; tick < 100_000; tick += 1) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("the condition never held");
}
