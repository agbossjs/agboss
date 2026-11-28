import { MESH_HTTP_HEADER } from "../../mesh/mesh-http.js";
import type { OutboundHttpRequest } from "../../mesh/outbound-http.js";

/**
 * The fetch of an MCP HTTP server with the mesh's header (#1320): the header is the framework's alone
 * (a declared or dynamic header of that name is dropped), signed for the one request and its origin.
 * With a header to send, redirects are never left to `fetch`: a hop on the same origin is followed here
 * and signed again for its own URL; a hop to another origin is not followed — the redirect answer is
 * handed back, and the signed header never leaves the origin it was signed for.
 */

const MAX_REDIRECTS = 3;
const HTTP_REDIRECTS = 300;
const HTTP_NOT_REDIRECTS = 400;

const withoutMeshHeader = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => name.toLowerCase() !== MESH_HTTP_HEADER.toLowerCase(),
    ),
  );

const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

const isRedirectStatus = (status: number): boolean =>
  status >= HTTP_REDIRECTS && status < HTTP_NOT_REDIRECTS;

/** What a hop of a redirect is made of: GET only is repeated as it was; the others are not followed. */
const isRepeatable = (init: RequestInit | undefined): boolean =>
  (init?.method ?? "GET").toUpperCase() === "GET";

/**
 * The URL a redirect answer leads to on the request's own origin, to be followed and signed again;
 * `undefined` when the answer is final: no redirect, not a GET, too many hops, or another origin.
 */
function sameOriginHopOf(
  response: Response,
  init: RequestInit | undefined,
  at: { readonly url: string; readonly home: URL; readonly hops: number },
): string | undefined {
  const location = response.headers.get("location");
  if (location === null || !isRedirectStatus(response.status) || !isRepeatable(init))
    return undefined;
  if (at.hops >= MAX_REDIRECTS) return undefined;
  const next = new URL(location, at.url);
  return next.origin === at.home.origin ? next.href : undefined;
}

/** One request of the client: its headers (the declared, then the dynamic) and the mesh's, signed. */
export async function signedFetch(
  fetcher: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  headers: Record<string, string>,
  meshHeader: ((request: OutboundHttpRequest) => string | undefined) | undefined,
): Promise<Response> {
  const unsigned = withoutMeshHeader(headers);
  const home = new URL(urlOf(input));
  let url = home.href;
  for (let hops = 0; ; hops += 1) {
    const signature = meshHeader?.({ url, method: init?.method ?? "GET", body: init?.body });
    if (signature === undefined)
      return fetcher(hops === 0 ? input : url, { ...init, headers: unsigned });
    const response = await fetcher(url, {
      ...init,
      headers: { ...unsigned, [MESH_HTTP_HEADER]: signature },
      redirect: "manual",
    });
    const next = sameOriginHopOf(response, init, { url, home, hops });
    // no next hop: the answer is final — a redirect to another origin is handed back, nothing sent there
    if (next === undefined) return response;
    url = next;
  }
}
