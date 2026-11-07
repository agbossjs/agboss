import type { AgentCard } from "@a2a-js/sdk";
import {
  ClientFactory,
  ClientFactoryOptions,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type Client,
} from "@a2a-js/sdk/client";
import { A2ACallerRejectedError } from "../a2a-caller.js";
import { A2AOriginSite } from "./a2a-guard-errors.js";
import { observeEcho, type EchoWatch } from "./a2a-echo.js";
import { originRefusalOf, type OriginPolicy } from "./a2a-origins.js";

/**
 * The client's wire (#809): the official SDK's `Client` over the agent's card, every request
 * through one fetch — the client's origins only, its headers, no redirect followed off them — and
 * what goes wrong said by status only (`a2a-wire-errors.ts` reads it into codes).
 */

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_REDIRECTS = 300;
const HTTP_NOT_REDIRECTS = 400;
const MAX_REDIRECTS = 3;

/** A request that never got an answer (a refused connection, a reset, DNS): the fetcher's error. */
export class A2ANetworkError extends Error {
  override name = "A2ANetworkError";
  constructor(cause: unknown) {
    super("the A2A request got no answer (network)", { cause });
  }
}

/**
 * A request that was never sent (#809): what had to come first failed — the client's own
 * `getHeaders()`, what the mesh signs. Certainly nothing reached the agent.
 */
export class A2ANotSentError extends Error {
  override name = "A2ANotSentError";
  constructor(cause: unknown) {
    super("the A2A request was not sent: what it needed first failed", { cause });
  }
}

/** An HTTP answer that is no A2A error answer: its status only, its body never read into text. */
export class HttpStatusError extends Error {
  constructor(readonly httpStatus: number) {
    super(`HTTP ${String(httpStatus)}`);
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/** A failed response's JSON body, `undefined` when it has none. */
const bodyOf = (response: Response): Promise<unknown> =>
  response
    .clone()
    .json()
    .catch(() => undefined);

/** Whether a request is a JSON-RPC one (its body names `jsonrpc`), else an HTTP+JSON one. */
function isJsonRpcRequest(init: RequestInit | undefined): boolean {
  // Stryker disable next-line ConditionalExpression,StringLiteral: JSON.parse refuses a body that is no text too — the guard types it
  if (typeof init?.body !== "string") return false;
  try {
    const body: unknown = JSON.parse(init.body);
    return isRecord(body) && "jsonrpc" in body;
  } catch {
    return false; // no JSON body (the card, an HTTP+JSON GET): not JSON-RPC
  }
}

/**
 * Whether a failed response's body is an A2A error the request's binding reads itself: a JSON-RPC
 * error (`{ jsonrpc, error }`) for a JSON-RPC request, an HTTP+JSON one (`{ error: { … } }`) for
 * any other — never one binding's body for the other's request, which would lose its status.
 */
async function isA2AErrorBody(response: Response, isJsonRpc: boolean): Promise<boolean> {
  const body = await bodyOf(response);
  if (!isRecord(body) || !isRecord(body.error)) return false;
  return isJsonRpc === "jsonrpc" in body;
}

/** A `401` / `403` naming an `a2a.caller-*` code: an AGBoss server refused the caller (#387). */
async function callerRejectionOf(response: Response): Promise<A2ACallerRejectedError | undefined> {
  if (response.status !== HTTP_UNAUTHORIZED && response.status !== HTTP_FORBIDDEN) return undefined;
  const body = await bodyOf(response);
  const wireCode = String(isRecord(body) ? body.code : undefined);
  if (!/^a2a\.caller-[a-z-]{1,40}$/u.test(wireCode)) return undefined;
  // the server's reason is its own text: the code says what happened
  return new A2ACallerRejectedError(
    response.status,
    wireCode,
    "refused by the agent's caller resolver",
  );
}

const urlOfInput = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

const isRedirect = (response: Response): boolean =>
  response.type === "opaqueredirect" ||
  (response.status >= HTTP_REDIRECTS && response.status < HTTP_NOT_REDIRECTS);

/** The request's headers: the client's (static, then `getHeaders()`), the SDK's own last. */
async function headersFor(
  headersOf: () => Promise<Record<string, string>>,
  init: RequestInit | undefined,
): Promise<Headers> {
  let extra: Record<string, string>;
  try {
    extra = await headersOf();
  } catch (error) {
    throw new A2ANotSentError(error); // a token refresh that failed: nothing went out
  }
  const headers = new Headers(extra);
  new Headers(init?.headers).forEach((value, name) => {
    headers.set(name, value);
  });
  return headers;
}

/** One fetch: a network failure as `A2ANetworkError`, an aborted one as its reason. */
async function fetchedOnce(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetcher(url, init);
  } catch (error) {
    if (init.signal?.aborted === true) throw init.signal.reason;
    throw new A2ANetworkError(error);
  }
}

/** Where a hop of a request is: its URL, its method, the redirects followed so far. */
interface Hop {
  readonly url: string;
  readonly isGet: boolean;
  readonly isJsonRpc: boolean;
  readonly redirects: number;
}

/** A redirect followed on the client's origins (a `GET` only, up to three): the next URL. */
function redirectedOf(policy: OriginPolicy, response: Response, hop: Hop): string {
  const location = response.headers.get("location");
  if (location === null || !hop.isGet || hop.redirects >= MAX_REDIRECTS) {
    throw new HttpStatusError(response.status);
  }
  const next = new URL(location, hop.url).href;
  const elsewhere = originRefusalOf(policy, next, A2AOriginSite.Redirect);
  if (elsewhere !== undefined) throw elsewhere;
  return next;
}

/**
 * An answer as the client takes it: a redirect followed (`redirectedOf`); an answer from another
 * origin (a fetcher that followed a redirect itself) refused; a refused caller, an A2A error
 * answer (for the SDK) or a status.
 */
async function answerOf(
  policy: OriginPolicy,
  response: Response,
  hop: Hop,
): Promise<Response | { readonly next: string }> {
  if (isRedirect(response)) return { next: redirectedOf(policy, response, hop) };
  const answeredFrom = response.url === "" ? hop.url : response.url;
  const elsewhere = originRefusalOf(policy, answeredFrom, A2AOriginSite.Redirect);
  if (elsewhere !== undefined) throw elsewhere;
  if (response.ok) return response;
  const rejection = await callerRejectionOf(response);
  if (rejection !== undefined) throw rejection;
  if (await isA2AErrorBody(response, hop.isJsonRpc)) return response;
  throw new HttpStatusError(response.status);
}

/**
 * The fetch every request of a client goes through: only to the client's origins (any other is
 * `A2AOriginError`, nothing sent — so its headers never leave them), redirects never followed by
 * the fetcher (`redirect: "manual"`), the caller's headers on each request, the answer as
 * `answerOf` takes it — and, for a send that asked for `echo.uri`, whether its answer echoed it.
 */
export function wireFetchOf(
  fetcher: typeof fetch,
  headersOf: () => Promise<Record<string, string>>,
  policy: OriginPolicy,
  echo?: EchoWatch,
): typeof fetch {
  return async (input, init) => {
    let url = urlOfInput(input);
    const refused = originRefusalOf(policy, url, A2AOriginSite.Request);
    if (refused !== undefined) throw refused;
    const headers = await headersFor(headersOf, init);
    const isGet = (init?.method ?? "GET").toUpperCase() === "GET";
    const isJsonRpc = isJsonRpcRequest(init);
    for (let redirects = 0; ; redirects += 1) {
      const response = await fetchedOnce(fetcher, url, { ...init, headers, redirect: "manual" });
      const answer = await answerOf(policy, response, { url, isGet, isJsonRpc, redirects });
      if (answer instanceof Response) {
        if (echo !== undefined) {
          // Stryker disable next-line OptionalChaining: a request with no init asked for no extension (its headers are the client's only), so nothing reads its body
          observeEcho(echo.uri, { headers, body: init?.body }, answer, echo.onEcho);
        }
        return answer;
      }
      url = answer.next;
    }
  };
}

/** The SDK client of a checked card: JSON-RPC or HTTP+JSON, whichever the card prefers. */
export function sdkClientOf(card: AgentCard, fetchImpl: typeof fetch): Promise<Client> {
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [
        new JsonRpcTransportFactory({ fetchImpl }),
        new RestTransportFactory({ fetchImpl }),
      ],
    }),
  );
  return factory.createFromAgentCard(card);
}
