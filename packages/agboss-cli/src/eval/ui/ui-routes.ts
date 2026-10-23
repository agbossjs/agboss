import { timingSafeEqual } from "node:crypto";
import { boundedPageOf } from "../html/bounded-page.js";
import { CONTENT_SECURITY_POLICY } from "../html/document.js";
import { sizeText } from "../html/format.js";
import { indexPageOf } from "./index-page.js";
import { runFilesOf } from "./run-folder.js";

/**
 * What `agboss eval ui` answers (#397 PR 3), read-only: `GET /` — the folder's runs; `GET
 * /runs/<file>` — that run's report page, the same as `--html` writes. Every request names the
 * printed token (`?token=`) and a loopback `Host` of the server's port (a page of another site
 * cannot reach it through DNS rebinding); nothing but GET and HEAD.
 */

/** What a request says, as the routes read it. */
export interface EvalUiRequest {
  readonly method: string;
  /** The request target: path and query. */
  readonly url: string;
  readonly host: string | undefined;
}

/** What the server sends back. */
export interface EvalUiResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** What the routes serve and whom. */
export interface EvalUiSettings {
  readonly folder: string;
  readonly token: string;
  readonly port: number;
}

const BASE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

const text = (
  status: number,
  body: string,
  extra: Readonly<Record<string, string>> = {},
): EvalUiResponse => ({
  status,
  headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...extra },
  body: `${body}\n`,
});

const html = (body: string): EvalUiResponse => ({
  status: 200,
  headers: {
    ...BASE_HEADERS,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  },
  body,
});

const isToken = (given: string | null, token: string): boolean =>
  given !== null &&
  given.length === token.length &&
  timingSafeEqual(Buffer.from(given), Buffer.from(token));

/** The hosts a browser on this machine sends for the server's port. */
const hostsOf = (port: number): ReadonlySet<string> =>
  new Set([`127.0.0.1:${String(port)}`, `localhost:${String(port)}`]);

function runPage(settings: EvalUiSettings, file: string): EvalUiResponse {
  const found = runFilesOf(settings.folder).find((each) => each.file === file);
  if (found === undefined) return text(404, `no run artifact named ${file} in ${settings.folder}`);
  if (found.kind === "invalid")
    return text(422, `${file} is not a run artifact this agboss reads: ${found.reason}`);
  const back = { href: `/?token=${settings.token}`, label: "← All runs" };
  const bounded = boundedPageOf(found.report, { back });
  if (bounded.kind === "too-large")
    return text(
      413,
      `the page of ${file} would be ${sizeText(bounded.bytes)} without any timeline: too large to show`,
    );
  return html(bounded.page);
}

/** The answer to one request. */
export function respondTo(request: EvalUiRequest, settings: EvalUiSettings): EvalUiResponse {
  if (request.host === undefined || !hostsOf(settings.port).has(request.host.toLowerCase()))
    return text(
      403,
      "agboss eval ui answers only http://127.0.0.1 or http://localhost on its own port",
    );
  const url = new URL(request.url, "http://127.0.0.1");
  if (!isToken(url.searchParams.get("token"), settings.token))
    return text(403, "agboss eval ui needs the token it printed: open the URL it printed");
  if (request.method !== "GET" && request.method !== "HEAD")
    return text(405, "agboss eval ui is read-only", { Allow: "GET, HEAD" });
  if (url.pathname === "/") {
    const runHref = (file: string, fragment?: string): string =>
      `/runs/${encodeURIComponent(file)}?token=${settings.token}${fragment === undefined ? "" : `#${fragment}`}`;
    return html(indexPageOf(settings.folder, runFilesOf(settings.folder), runHref));
  }
  const run = /^\/runs\/([^/]+)$/u.exec(url.pathname);
  if (run?.[1] !== undefined) return runPage(settings, decodeURIComponent(run[1]));
  return text(404, `nothing at ${url.pathname}`);
}
