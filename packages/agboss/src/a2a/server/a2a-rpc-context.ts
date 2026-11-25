import type { IncomingMessage } from "node:http";
import { Extensions } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import type { HttpCaller } from "../../http/http-auth.js";
import { A2A_MESH_EXTENSION, A2A_SKILLS_EXTENSION } from "../a2a-extension-uris.js";
import type { AdmittedRequest } from "./a2a-admitted.js";
import type { A2ARequestMesh } from "./a2a-mesh-admission.js";
import { callerState } from "./a2a-server-parts.js";

const VERSION_HEADER = "a2a-version";
const EXTENSIONS_HEADER = "a2a-extensions";
/** What an empty or missing `A2A-Version` means (spec §3.6). */
const LEGACY_VERSION = "0.3";

export const fieldOf = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

export const headerOf = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(",") : value;
};

export const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof value === "object" && value !== null && Symbol.asyncIterator in value;

/** The requested A2A version: none, or empty, means 0.3 (spec §3.6). */
export const versionOf = (req: IncomingMessage): string => {
  const asked = headerOf(req, VERSION_HEADER) ?? "";
  return asked === "" ? LEGACY_VERSION : asked;
};

/** The answer's headers: the extensions the call activated (echoed, spec §4.6). */
export function extensionHeadersOf(context: ServerCallContext): Record<string, string> {
  const activated = context.activatedExtensions ?? [];
  return activated.length === 0 ? {} : { [EXTENSIONS_HEADER]: activated.join(", ") };
}

/** The extensions a call activates when it asks for them: both of ours (echoed, spec §4.6). */
const SERVED_EXTENSIONS = [A2A_MESH_EXTENSION, A2A_SKILLS_EXTENSION] as const;

/** The call's context: its version, extensions, and the admitted caller with the request's end. */
export function contextOf(
  req: IncomingMessage,
  closed: AbortSignal,
  caller: HttpCaller,
  admitted: AdmittedRequest,
  mesh: A2ARequestMesh,
): ServerCallContext {
  const requestedExtensions = Extensions.parseServiceParameter(headerOf(req, EXTENSIONS_HEADER));
  const context = new ServerCallContext({
    requestedVersion: versionOf(req),
    requestedExtensions,
    state: callerState(caller, closed, admitted, mesh),
  });
  for (const uri of SERVED_EXTENSIONS)
    if (requestedExtensions.includes(uri)) context.addActivatedExtension(uri);
  return context;
}
