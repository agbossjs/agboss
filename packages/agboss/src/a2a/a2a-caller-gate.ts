import type { IncomingMessage, ServerResponse } from "node:http";
import type { Class } from "../components/injection.js";
import { ComponentError } from "../components/metadata.js";
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
    throw new ComponentError({
      message:
        `[http.not-an-authenticator] ${authenticator.name} is not an @HttpAuthenticator — ` +
        `decorate it with @HttpAuthenticator() and list it in @Application({ services })`,
    });
  }
  return { instance: app.resolve(authenticator) as HttpAuthenticatorHandler, meta };
}

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
      return { isAdmitted: true, caller: resolution.caller };
    }
    reject(res, resolution);
  } else {
    failResolution(res);
  }
  return { isAdmitted: false };
}
