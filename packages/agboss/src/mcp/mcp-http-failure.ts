import type { IncomingMessage, ServerResponse } from "node:http";
import { notifyHost, writeRejection } from "../a2a/a2a-caller-gate.js";
import type { FrameworkLog } from "../infrastructure/logger.js";

/** What the listener answers when it failed past its own answers: never the failure's text. */
const UNAVAILABLE = { code: "mcp.listener-failed", error: "the MCP server is not available" };

/**
 * A request the listener failed to serve past its own answers (#1319): logged by the error's class,
 * the host told through `onError`, and the client answered `503` — or, with the answer already
 * begun, its connection closed.
 */
export function failedRequest(
  failure: {
    readonly log: FrameworkLog;
    readonly onError?: ((error: unknown, req: IncomingMessage) => void) | undefined;
  },
  error: unknown,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const name = error instanceof Error ? error.name : typeof error;
  failure.log.error("mcp.listener-failed", `the MCP listener failed to serve a request: ${name}`);
  notifyHost(failure.onError, error, req);
  if (res.headersSent) res.destroy();
  else writeRejection(res, 503, UNAVAILABLE);
}
