import type { IncomingMessage, ServerResponse } from "node:http";
import type { Class } from "../components/injection.js";
import { ConfigError } from "../core/error-families/config-errors.js";
import {
  HttpAuthKind,
  isHttpAuthResult,
  type HttpAuthRequest,
  type HttpCaller,
  type RejectedHttpAuthResult,
} from "../http/http-auth.js";
import {
  httpAuthenticatorOf,
  type HttpAuthenticatorHandler,
  type HttpAuthenticatorMeta,
} from "../http/http-authenticator.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import { MeshInboundMode } from "../mesh/mesh.decorator.js";
import { meshSettingsOf, type MeshSettings } from "../mesh/mesh-settings.js";
import { A2A_CALLER_CODES, type A2AApp } from "./a2a-caller.js";

/** A refusal on the wire (#387): its code and reason. */
export interface A2ARejectionBody {
  readonly code: string;
  readonly error: string;
}

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_INTERNAL_SERVER_ERROR = 500;

/** What the gate decided: the caller to run for, or the answer already written. */
export type CallerGateOutcome =
  { readonly isAdmitted: true; readonly caller: HttpCaller } | { readonly isAdmitted: false };

/** The authenticator of a listener: its instance and what it declared. */
export interface ListenerAuthenticator {
  readonly instance: HttpAuthenticatorHandler;
  readonly meta: HttpAuthenticatorMeta;
}

/**
 * The `@HttpAuthenticator` of a listener, from the application's container (#387, #1316): a class
 * without the decorator, or one the application's container cannot create, and the listener does
 * not start.
 */
export function authenticatorOf(app: A2AApp, authenticator: Class): ListenerAuthenticator {
  const meta = httpAuthenticatorOf(authenticator);
  if (meta === undefined) {
    throw new ConfigError.Component({
      message:
        `[http.not-an-authenticator] ${authenticator.name} is not an @HttpAuthenticator — ` +
        `decorate it with @HttpAuthenticator() and list it in @Application({ services })`,
    });
  }
  return { instance: app.resolve(authenticator) as HttpAuthenticatorHandler, meta };
}

const CODE = "[http.authenticator-required-for-tenant-context]";
const refusedConfig = (why: string): ConfigError.Option =>
  new ConfigError.Option({ message: `${CODE} ${why}` });

/** Whether only signed peers can call: `@Mesh({ inboundMode: Strict })` with a peer whose tenant is trusted. */
const isMeshOnly = (settings: MeshSettings | undefined): boolean =>
  settings?.inboundMode === MeshInboundMode.Strict &&
  [...settings.peers.values()].some((peer) => peer.propagateTenant);

/**
 * The listener's authenticator, when it has one (#1320, #1316, #1319). `allowAnonymous: true` is the
 * one way to serve a caller no authenticator vouches for, and only an application with no
 * `tenantContext` of its own (the base one: a `tenantId` and nothing else) may; it is exclusive with
 * an `@HttpAuthenticator`. An application that declares a `tenantContext` needs an authenticator to
 * say whose tenant a caller is, and an application with neither needs one or `allowAnonymous` —
 * except a `@Mesh({ inboundMode: Strict })` with a peer that propagates its tenant, which only
 * signed peers can call. Otherwise the listener is not made (`ConfigError`, `[http.authenticator-required-for-tenant-context]`).
 */
export function listenerAuthenticatorOf(
  app: A2AApp,
  authenticator: Class | undefined,
  allowAnonymous = false,
): ListenerAuthenticator | undefined {
  const settings = meshSettingsOf(app);
  if (allowAnonymous && settings?.isBaseTenantContext !== true)
    throw refusedConfig(
      "allowAnonymous: true is refused: an application with a tenantContext needs an @HttpAuthenticator to say whose tenant a caller is",
    );
  if (allowAnonymous && authenticator !== undefined)
    throw refusedConfig(
      "allowAnonymous: true and an authenticator exclude each other: say who calls, or serve anonymous callers",
    );
  if (authenticator !== undefined) return authenticatorOf(app, authenticator);
  if (allowAnonymous || isMeshOnly(settings)) return undefined;
  throw refusedConfig(
    "the listener has no authenticator: declare an @HttpAuthenticator, listed in @Application({ services }), to say whose caller and tenant a request is — or, in an application with no tenantContext, allowAnonymous: true",
  );
}

/** Owners a host's authenticator may not name: a listener's own, made for callers that name none. */
const RESERVED_OWNERS = ["anonymous:", "mcp-session:", "a2a-task:"] as const;

/** Whether `ownerId` is one a listener made (never a host's). */
export const isSyntheticOwner = (ownerId: string | undefined): boolean =>
  ownerId !== undefined && RESERVED_OWNERS.some((prefix) => ownerId.startsWith(prefix));

/** Writes a refusal: its status, `{ code, error, … }`, a challenge for a `401`. */
export const writeRejection = (
  res: ServerResponse,
  status: number,
  body: A2ARejectionBody,
  challenge?: string,
): void => {
  const headers = {
    "content-type": "application/json",
    ...(challenge === undefined ? {} : { "www-authenticate": challenge }),
  };
  res.writeHead(status, headers).end(JSON.stringify(body));
};

/** A refused caller: `401` (+ its challenge) or `403`, with the host's reason. */
function reject(res: ServerResponse, resolution: RejectedHttpAuthResult): void {
  const error = resolution.reason;
  if (resolution.kind === HttpAuthKind.Forbidden) {
    writeRejection(res, HTTP_FORBIDDEN, { code: A2A_CALLER_CODES.forbidden, error });
    return;
  }
  const body = { code: A2A_CALLER_CODES.unauthenticated, error };
  writeRejection(res, HTTP_UNAUTHORIZED, body, resolution.challenge);
}

/** An authenticator that threw or answered nothing it built: `500`, never the error's text. */
function failResolution(res: ServerResponse): void {
  const body = {
    code: A2A_CALLER_CODES.resolutionFailed,
    error: "the caller could not be resolved",
  };
  writeRejection(res, HTTP_INTERNAL_SERVER_ERROR, body);
}

/** Tells the host's `onError` of an error; a failure of the hook itself is the host's, never the answer's. */
export function notifyHost(
  onError: ((error: unknown, req: IncomingMessage) => void) | undefined,
  error: unknown,
  req: IncomingMessage,
): void {
  try {
    onError?.(error, req);
  } catch {
    // the hook is the host's: its own failure never changes the answer
  }
}

/** The authenticator's answer, or `undefined` when it threw or returned something else. */
async function resolutionOf(
  authenticator: HttpAuthenticatorHandler,
  request: HttpAuthRequest,
  log: Pick<FrameworkLog, "error">,
  onError: ((error: unknown, req: IncomingMessage) => void) | undefined,
): Promise<unknown> {
  try {
    return await authenticator.authenticate(request);
  } catch (error) {
    // the host's own bug: its class in the log, never its text on the wire
    const name = error instanceof Error ? error.name : typeof error;
    log.error("a2a.caller-resolution-failed", `the HTTP authenticator threw: ${name}`);
    notifyHost(onError, error, request.http);
    return undefined;
  }
}

/**
 * Authenticates the request's caller before anything of it runs or a header is written (#387,
 * #808): admitted, or answered `401` / `403` / `500` — nothing run.
 */
export async function admitCaller(
  authenticator: HttpAuthenticatorHandler,
  request: HttpAuthRequest,
  res: ServerResponse,
  log: Pick<FrameworkLog, "error">,
  onError?: (error: unknown, req: IncomingMessage) => void,
): Promise<CallerGateOutcome> {
  const resolution = await resolutionOf(authenticator, request, log, onError);
  if (isHttpAuthResult(resolution)) {
    if (resolution.kind === HttpAuthKind.Authenticated) {
      // an owner of the listener's own kind is the host's bug: it would be taken for a capability
      if (isSyntheticOwner(resolution.caller.ownerId)) {
        log.error("a2a.caller-resolution-failed", "the HTTP authenticator named a reserved owner");
        failResolution(res);
        return { isAdmitted: false };
      }
      return { isAdmitted: true, caller: resolution.caller };
    }
    reject(res, resolution);
  } else {
    failResolution(res);
  }
  return { isAdmitted: false };
}

/** What the binding knows of its listener: its authenticator (if any), its endpoint, its origin. */
export const listenerOf = (
  options: { readonly endpoint: Class; readonly allowAnonymous?: boolean },
  checked: { readonly authenticator: ListenerAuthenticator | undefined; readonly url: string },
): {
  readonly authenticator?: HttpAuthenticatorHandler;
  readonly allowAnonymous: boolean;
  readonly endpoint: Class;
  readonly origin: string;
} => ({
  ...(checked.authenticator === undefined ? {} : { authenticator: checked.authenticator.instance }),
  allowAnonymous: options.allowAnonymous === true,
  endpoint: options.endpoint,
  origin: new URL(checked.url).origin,
});
