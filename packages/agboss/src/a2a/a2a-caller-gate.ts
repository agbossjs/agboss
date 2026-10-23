import type { IncomingMessage, ServerResponse } from "node:http";
import { isListedProvider } from "../application/listed-providers.js";
import type { Class } from "../components/injection.js";
import { ComponentError } from "../components/metadata.js";
import {
  A2A_CALLER_CODES,
  A2ACallerResolutionKind,
  isA2ACallerResolution,
  type A2AApp,
  type A2ACaller,
  type A2ACallerResolver,
  type A2ARoute,
  type RejectedA2ACallerResolution,
} from "./a2a-caller.js";

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_INTERNAL_SERVER_ERROR = 500;

/** What the gate decided: the caller to run for, or the answer already written. */
export type CallerGateOutcome<TStart extends Class> =
  | { readonly isAdmitted: true; readonly caller: A2ACaller<TStart> }
  | { readonly isAdmitted: false };

/**
 * The caller resolver of a listener, from the application's container (#387): listed in the
 * application's or a workflow's `providers`, else the listener does not start — never `new`.
 */
export function callerResolverOf<TStart extends Class>(
  app: A2AApp,
  callerResolver: Class<A2ACallerResolver<TStart>>,
): A2ACallerResolver<TStart> {
  if (isListedProvider(app, callerResolver) === false) {
    const name = callerResolver.name;
    throw new ComponentError(
      `[a2a.caller-resolver-not-listed] ${name} is not listed in the application's providers — ` +
        `list it in @Application({ providers }) or a @Workflow({ providers }): the listener takes it from the container`,
    );
  }
  return app.resolve(callerResolver);
}

const writeRejection = (
  res: ServerResponse,
  status: number,
  body: { readonly code: string; readonly error: string },
  challenge?: string,
): void => {
  const headers = {
    "content-type": "application/json",
    ...(challenge === undefined ? {} : { "www-authenticate": challenge }),
  };
  res.writeHead(status, headers).end(JSON.stringify(body));
};

/** A refused caller: `401` (+ its challenge) or `403`, with the host's reason. */
function reject(res: ServerResponse, resolution: RejectedA2ACallerResolution): void {
  const error = resolution.reason;
  if (resolution.kind === A2ACallerResolutionKind.Forbidden) {
    writeRejection(res, HTTP_FORBIDDEN, { code: A2A_CALLER_CODES.forbidden, error });
    return;
  }
  const body = { code: A2A_CALLER_CODES.unauthenticated, error };
  writeRejection(res, HTTP_UNAUTHORIZED, body, resolution.challenge);
}

/** A resolver that threw or answered nothing it built: `500`, never the error's text. */
function failResolution(res: ServerResponse): void {
  const body = {
    code: A2A_CALLER_CODES.resolutionFailed,
    error: "the caller could not be resolved",
  };
  writeRejection(res, HTTP_INTERNAL_SERVER_ERROR, body);
}

/** The resolver's answer, or `undefined` when it threw or returned something else. */
async function resolutionOf<TStart extends Class>(
  resolver: A2ACallerResolver<TStart>,
  route: A2ARoute,
  req: IncomingMessage,
): Promise<unknown> {
  try {
    return await resolver.resolveCaller({ route, http: req });
  } catch {
    return undefined;
  }
}

/**
 * Resolves the request's caller before its body is read or a header written (#387): admitted, or
 * answered `401` / `403` / `500` — its body left unread and nothing run.
 */
export async function admitCaller<TStart extends Class>(
  resolver: A2ACallerResolver<TStart>,
  route: A2ARoute,
  exchange: { readonly req: IncomingMessage; readonly res: ServerResponse },
): Promise<CallerGateOutcome<TStart>> {
  const { req, res } = exchange;
  const resolution = await resolutionOf(resolver, route, req);
  if (isA2ACallerResolution<TStart>(resolution)) {
    if (resolution.kind === A2ACallerResolutionKind.Resolved) {
      return { isAdmitted: true, caller: resolution.caller };
    }
    reject(res, resolution);
  } else {
    failResolution(res);
  }
  req.resume(); // the body is discarded unread
  return { isAdmitted: false };
}
