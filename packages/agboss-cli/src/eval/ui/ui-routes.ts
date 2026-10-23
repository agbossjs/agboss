import { timingSafeEqual } from "node:crypto";
import type { EvalRunReport } from "agboss/eval";
import { calibrateJudges, type EvalFailureTag } from "agboss/internal";
import type { HtmlElement } from "../html/html.js";
import { boundedPageOf } from "../html/bounded-page.js";
import { sizeText } from "../html/format.js";
import { calibrationSectionOf } from "./calibration-section.js";
import { indexPageOf } from "./index-page.js";
import { labelFormsOf } from "./label-forms.js";
import { suiteLabelsOf, type SuiteLabels } from "./labels-file.js";
import { runFilesOf } from "./run-folder.js";
import { saveLabel } from "./save-label.js";
import { goldenFormOf, saveGoldenCase, type GoldenSource } from "./golden-case.js";
import { element } from "../html/html.js";
import { htmlResponse, textResponse, type EvalUiResponse } from "./ui-responses.js";

export type { EvalUiResponse } from "./ui-responses.js";

/**
 * What `agboss eval ui` answers (#397 PR 3–4): `GET /` — the folder's runs; `GET /runs/<file>` —
 * that run's report page with its label forms and calibration; `POST /runs/<file>/labels` — a label
 * saved. Every request names the printed token (a POST in its form) and a loopback `Host` of the
 * server's port (DNS rebinding); a POST also comes from the server's own page (`Origin`).
 */

/** What a request says, as the routes read it. */
export interface EvalUiRequest {
  readonly method: string;
  /** The request target: path and query. */
  readonly url: string;
  readonly host: string | undefined;
  readonly origin?: string | undefined;
  /** A POST's form, as sent (`application/x-www-form-urlencoded`). */
  readonly body?: string;
}

/** What the routes serve and whom. */
export interface EvalUiSettings {
  readonly folder: string;
  readonly token: string;
  readonly port: number;
  /** Where labels are written: `eval/labels`, one `<suite>.jsonl` each. */
  readonly labelsFolder: string;
  /** The taxonomy's tags; undefined without a taxonomy file (no tags offered). */
  readonly tags: readonly EvalFailureTag[] | undefined;
  /** Who labels, as the forms start. */
  readonly labeler: string;
  /** Where "save as golden case" reads executions and writes cases (#397 PR 5). */
  readonly golden: GoldenSource;
}

const isToken = (given: string | null, token: string): boolean =>
  given !== null &&
  given.length === token.length &&
  timingSafeEqual(Buffer.from(given), Buffer.from(token));

/** The origins a browser on this machine has for the server's port. */
const originsOf = (port: number): readonly string[] => [
  `127.0.0.1:${String(port)}`,
  `localhost:${String(port)}`,
];

const isOwnHost = (host: string | undefined, port: number): boolean =>
  host !== undefined && originsOf(port).includes(host.toLowerCase());

const isOwnOrigin = (origin: string | undefined, port: number): boolean =>
  origin === undefined || originsOf(port).some((own) => origin.toLowerCase() === `http://${own}`);

/** A run of the folder by its file name, or the answer when there is none. */
type FoundRun =
  | { readonly kind: "run"; readonly report: EvalRunReport }
  | { readonly kind: "answer"; readonly response: EvalUiResponse };

function runOf(settings: EvalUiSettings, file: string): FoundRun {
  const found = runFilesOf(settings.folder).find((each) => each.file === file);
  if (found === undefined)
    return {
      kind: "answer",
      response: textResponse(404, `no run artifact named ${file} in ${settings.folder}`),
    };
  if (found.kind === "invalid")
    return {
      kind: "answer",
      response: textResponse(
        422,
        `${file} is not a run artifact this agboss reads: ${found.reason}`,
      ),
    };
  return { kind: "run", report: found.report };
}

/** The calibration section of a run, when its suite's labels can be read. */
function calibrationOf(report: EvalRunReport, labels: SuiteLabels): HtmlElement[] {
  if (labels.kind === "invalid") return [];
  const calibrated = calibrateJudges(report, labels.labels);
  return calibrated.kind === "calibrated"
    ? [calibrationSectionOf(calibrated.calibration, labels.file)]
    : [];
}

const runHrefOf =
  (settings: EvalUiSettings) =>
  (file: string, fragment?: string, saved?: string): string =>
    `/runs/${encodeURIComponent(file)}?token=${settings.token}${saved === undefined ? "" : `&saved=${encodeURIComponent(saved)}`}${fragment === undefined ? "" : `#${fragment}`}`;

function runPage(settings: EvalUiSettings, file: string, saved: string | null): EvalUiResponse {
  const found = runOf(settings, file);
  if (found.kind === "answer") return found.response;
  const { report } = found;
  const labels = suiteLabelsOf(settings.labelsFolder, report.suite);
  const given = labels.kind === "read" ? labels.labels : [];
  const action = `/runs/${encodeURIComponent(file)}`;
  const labelling = {
    action: `${action}/labels`,
    token: settings.token,
    labeler: settings.labeler,
    tags: settings.tags ?? [],
    labels: given,
  };
  const golden = {
    source: settings.golden,
    action: `${action}/golden`,
    token: settings.token,
    report,
  };
  const bounded = boundedPageOf(report, {
    back: { href: `/?token=${settings.token}`, label: "← All runs" },
    ...(saved === null ? {} : { notice: `Saved as the case "${saved}" of ${report.suite}.` }),
    sections: calibrationOf(report, labels),
    isPostingForms: true,
    runExtrasOf: (caseIndex, each, result) =>
      element("div", { class: "run-extras" }, [
        labelFormsOf(labelling, caseIndex, each, result),
        goldenFormOf(golden, caseIndex, each, result),
      ]),
  });
  if (bounded.kind === "too-large")
    return textResponse(
      413,
      `the page of ${file} would be ${sizeText(bounded.bytes)} without any timeline: too large to show`,
    );
  return htmlResponse(bounded.page);
}

function postLabel(settings: EvalUiSettings, file: string, form: URLSearchParams): EvalUiResponse {
  const found = runOf(settings, file);
  if (found.kind === "answer") return found.response;
  return saveLabel(
    {
      file,
      report: found.report,
      labelsFolder: settings.labelsFolder,
      tags: settings.tags,
      runPage: (fragment) => runHrefOf(settings)(file, fragment),
    },
    form,
  );
}

function routeGet(settings: EvalUiSettings, url: URL): EvalUiResponse {
  if (!isToken(url.searchParams.get("token"), settings.token))
    return textResponse(403, "agboss eval ui needs the token it printed: open the URL it printed");
  if (url.pathname === "/")
    return htmlResponse(
      indexPageOf(settings.folder, runFilesOf(settings.folder), runHrefOf(settings)),
    );
  const run = /^\/runs\/([^/]+)$/u.exec(url.pathname);
  if (run?.[1] !== undefined)
    return runPage(settings, decodeURIComponent(run[1]), url.searchParams.get("saved"));
  return textResponse(404, `nothing at ${url.pathname}`);
}

async function routePost(
  settings: EvalUiSettings,
  url: URL,
  request: EvalUiRequest,
): Promise<EvalUiResponse> {
  if (!isOwnOrigin(request.origin, settings.port))
    return textResponse(403, "agboss eval ui takes forms from its own pages only");
  const form = new URLSearchParams(request.body ?? "");
  if (!isToken(form.get("token"), settings.token))
    return textResponse(403, "agboss eval ui needs the token it printed in the form");
  const labels = /^\/runs\/([^/]+)\/labels$/u.exec(url.pathname);
  if (labels?.[1] !== undefined) return postLabel(settings, decodeURIComponent(labels[1]), form);
  const golden = /^\/runs\/([^/]+)\/golden$/u.exec(url.pathname);
  if (golden?.[1] !== undefined) return postGolden(settings, decodeURIComponent(golden[1]), form);
  return textResponse(404, `nothing to post to at ${url.pathname}`);
}

function postGolden(
  settings: EvalUiSettings,
  file: string,
  form: URLSearchParams,
): Promise<EvalUiResponse> | EvalUiResponse {
  const found = runOf(settings, file);
  if (found.kind === "answer") return found.response;
  return saveGoldenCase(
    {
      source: settings.golden,
      report: found.report,
      runPage: (fragment, saved) => runHrefOf(settings)(file, fragment, saved),
    },
    form,
  );
}

/** The answer to one request. */
export async function respondTo(
  request: EvalUiRequest,
  settings: EvalUiSettings,
): Promise<EvalUiResponse> {
  if (!isOwnHost(request.host, settings.port))
    return textResponse(
      403,
      "agboss eval ui answers only http://127.0.0.1 or http://localhost on its own port",
    );
  const url = new URL(request.url, "http://127.0.0.1");
  if (request.method === "GET" || request.method === "HEAD") return routeGet(settings, url);
  if (request.method === "POST") return routePost(settings, url, request);
  return textResponse(405, "agboss eval ui answers GET, HEAD and its own forms' POST", {
    Allow: "GET, HEAD, POST",
  });
}
