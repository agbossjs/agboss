import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { IncomingMessage } from "node:http";
import type { McpCaller } from "./mcp-service-helpers.js";

/** What a request's verified identity is passed on as to the server: the SDK's `req.auth`, read back per message. */
const verified = new WeakMap<object, McpCaller>();

/** What a message with no auth info is looked up as: nothing was ever verified under it. */
const UNVERIFIED = {};

/** Marks `req` as carrying `identity`, for the server that handles it. */
export function carrying(req: IncomingMessage, identity: McpCaller): void {
  const info: AuthInfo = { token: "", clientId: "", scopes: [] };
  verified.set(info, identity);
  (req as IncomingMessage & { auth?: AuthInfo }).auth = info;
}

/** The identity of the message being served: the one its own request was verified as; none is refused. */
export function messageIdentity(extra: { readonly authInfo?: AuthInfo }): McpCaller {
  const identity = verified.get(extra.authInfo ?? UNVERIFIED);
  if (identity === undefined) throw new Error("an MCP message arrived with no verified identity");
  return identity;
}
