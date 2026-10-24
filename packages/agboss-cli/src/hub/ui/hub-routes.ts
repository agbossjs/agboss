import { CliError } from "../../cli/errors.js";
import { isOwnHost, isToken } from "../../eval/ui/ui-guard.js";
import {
  htmlResponse,
  jsonResponse,
  textResponse,
  type EvalUiResponse,
} from "../../eval/ui/ui-responses.js";
import type { LocalUiRequest, LocalUiServed } from "../../eval/ui/ui-server.js";
import { executionTreeOf } from "../execution-trees.js";
import { renderHubPage } from "../html/hub-page.js";
import { HUB_PAGE_STYLE } from "../html/hub-style.js";
import type { HubInputs } from "../hub-inputs.js";
import { meshOf, type HubMesh } from "../mesh.js";
import { readHubInputs } from "../read-inputs.js";
import { recordQueryOf, searchRecords } from "./record-search.js";
import { recordsPageOf } from "./records-page.js";

/**
 * What `agboss hub ui` answers (#401 PR 6), read-only, behind #397's rules (the printed token, a
 * loopback `Host` of its own port, no CORS — no `Access-Control-*` header is ever sent): `GET /` —
 * the page `hub show` writes; `GET /records` — the kept executions of every input, searched and a
 * page at a time; the API, JSON: `/api/mesh`, `/api/applications/<name>`,
 * `/api/trees/<rootExecutionId>`, `/api/records?…`, `/api/radar`, `/api/blast-radius` (#401 PR 7). The paths are read again on every
 * request, so a new export shows at the next reload.
 */

/** What the routes serve. */
export interface HubUiSettings extends LocalUiServed {
  readonly cwd: string;
  readonly paths: readonly string[];
}

/** The inputs now, or the answer when a file no longer reads. */
type Read =
  | { readonly kind: "read"; readonly inputs: HubInputs; readonly mesh: HubMesh }
  | { readonly kind: "answer"; readonly response: EvalUiResponse };

function readNow(settings: HubUiSettings): Read {
  try {
    const inputs = readHubInputs(settings.cwd, settings.paths);
    return { kind: "read", inputs, mesh: meshOf(inputs) };
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    return { kind: "answer", response: textResponse(422, `[${error.code}] ${error.message}`) };
  }
}

const notFound = (what: string): EvalUiResponse => jsonResponse(404, { error: `no ${what}` });

/** One segment after a prefix, decoded; undefined when the path is not that. */
function segmentAfter(path: string, prefix: string): string | undefined {
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length);
  return rest === "" || rest.includes("/") ? undefined : decodeURIComponent(rest);
}

function apiOf(read: { inputs: HubInputs; mesh: HubMesh }, url: URL): EvalUiResponse {
  const { mesh } = read;
  if (url.pathname === "/api/mesh")
    return jsonResponse(200, {
      applications: mesh.applications,
      edges: mesh.edges,
      declaredEdges: mesh.federation.declaredEdges,
    });
  if (url.pathname === "/api/blast-radius") return jsonResponse(200, mesh.federation);
  if (url.pathname === "/api/radar") return jsonResponse(200, mesh.radar);
  if (url.pathname === "/api/records")
    return jsonResponse(200, searchRecords(read.inputs.records, recordQueryOf(url.searchParams)));
  const name = segmentAfter(url.pathname, "/api/applications/");
  if (name !== undefined) {
    const found = mesh.applications.find((application) => application.name === name);
    return found === undefined ? notFound(`application ${name}`) : jsonResponse(200, found);
  }
  const root = segmentAfter(url.pathname, "/api/trees/");
  if (root !== undefined) {
    const tree = executionTreeOf(mesh.trees, root);
    return tree === undefined ? notFound(`tree of ${root}`) : jsonResponse(200, tree);
  }
  return notFound(`API at ${url.pathname}`);
}

function routeGet(settings: HubUiSettings, url: URL): EvalUiResponse {
  if (!isToken(url.searchParams.get("token"), settings.token))
    return textResponse(403, "agboss hub ui needs the token it printed: open the URL it printed");
  const read = readNow(settings);
  if (read.kind === "answer") return read.response;
  if (url.pathname === "/") {
    const page = renderHubPage(read.mesh, { recordsHref: `/records?token=${settings.token}` });
    return htmlResponse(page, HUB_PAGE_STYLE);
  }
  if (url.pathname === "/records") {
    const page = searchRecords(read.inputs.records, recordQueryOf(url.searchParams));
    return htmlResponse(recordsPageOf(page, url.searchParams, settings.token), HUB_PAGE_STYLE);
  }
  if (url.pathname.startsWith("/api/")) return apiOf(read, url);
  return textResponse(404, `nothing at ${url.pathname}`);
}

/** The answer to one request. */
export function respondToHub(request: LocalUiRequest, settings: HubUiSettings): EvalUiResponse {
  if (!isOwnHost(request.host, settings.port))
    return textResponse(
      403,
      "agboss hub ui answers only http://127.0.0.1 or http://localhost on its own port",
    );
  if (request.method !== "GET" && request.method !== "HEAD")
    return textResponse(405, "agboss hub ui is read-only: it answers GET and HEAD", {
      Allow: "GET, HEAD",
    });
  return routeGet(settings, new URL(request.url, "http://127.0.0.1"));
}
