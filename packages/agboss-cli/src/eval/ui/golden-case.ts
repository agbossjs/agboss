import { createHash } from "node:crypto";
import { join } from "node:path";
import type { EvalCaseReport, EvalRunReport, EvalRunResult } from "agboss/eval";
import type { OpenedExecutionHistory } from "agboss/internal";
import { CliError } from "../../cli/errors.js";
import { ScaffoldConflictError, ScaffoldError } from "../../scaffold/errors.js";
import { evalSuiteSourceOf, planEvalCase } from "../../scaffold/generate-eval-case.js";
import { element, type HtmlElement } from "../html/html.js";
import { runAnchor } from "../html/sections.js";
import { writeAtomically } from "./atomic-write.js";
import { formRunOf, goldenDraftOf, GoldenRefusal } from "./golden-draft.js";
import { seeOther, textResponse, type EvalUiResponse } from "./ui-responses.js";

/**
 * "Save as golden case" in `agboss eval ui` (#397 PR 5, S2 Q5): a run's execution, read from the
 * application's execution history, drafted into a case the way `agboss generate eval-case
 * --from-execution` drafts it (`recordDraftOf`, `planEvalCase` — one builder, #396 PR 8) and written
 * into the suite's file directly: whole and atomically, only if the file is still the one the page
 * was made from (its ETag; else 409), never over a case of the same name (409).
 */

/** Where the cases come from: the application's kept history, or why the button cannot work. */
export type GoldenSource =
  | {
      readonly kind: "kept";
      /** The project's root (where package.json is): the suites' files are found under it. */
      readonly root: string;
      /** `--application`, when given (else package.json's). */
      readonly application: string | undefined;
      readonly history: OpenedExecutionHistory["history"];
    }
  | { readonly kind: "off"; readonly reason: string };

/** A file's ETag: what the page saw. */
export const etagOf = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex").slice(0, 32);

/** The suite's file and its ETag; why not, when the project has no such suite. */
function suiteStateOf(source: Extract<GoldenSource, { kind: "kept" }>, suite: string) {
  try {
    const found = evalSuiteSourceOf(source.root, { application: source.application, suite });
    return { kind: "found", path: found.file.path, etag: etagOf(found.file.content) } as const;
  } catch (error) {
    if (error instanceof ScaffoldError || error instanceof CliError)
      return { kind: "missing", reason: error.message } as const;
    throw error;
  }
}

/** What a run's golden form needs. */
export interface GoldenFormContext {
  readonly source: GoldenSource;
  readonly action: string;
  readonly token: string;
  readonly report: EvalRunReport;
}

/** A name for the new case: the case's and the run's, kebab-case. */
const suggestedName = (found: EvalCaseReport, result: EvalRunResult): string =>
  `${found.name}-run-${String(result.run)}`;

/** The run's "save as golden case" form, or why there is none. */
export function goldenFormOf(
  context: GoldenFormContext,
  caseIndex: number,
  found: EvalCaseReport,
  result: EvalRunResult,
): HtmlElement | undefined {
  const { source } = context;
  if (result.executionId === undefined) return undefined;
  const note = (text: string): HtmlElement =>
    element("p", { class: "muted golden" }, [`Save as golden case: ${text}`]);
  if (source.kind === "off") return note(source.reason);
  const state = suiteStateOf(source, context.report.suite);
  if (state.kind === "missing") return note(state.reason);
  const id = `golden-${String(caseIndex + 1)}-${String(result.run)}`;
  return element("form", { method: "post", action: context.action, class: "label-form golden" }, [
    element("input", { type: "hidden", name: "token", value: context.token }),
    element("input", { type: "hidden", name: "executionId", value: result.executionId }),
    element("input", { type: "hidden", name: "run", value: `${found.name}#${String(result.run)}` }),
    element("input", { type: "hidden", name: "etag", value: state.etag }),
    element("label", { for: `${id}-name` }, [
      `Save run ${String(result.run)} as a case of ${context.report.suite} (${state.path}), named `,
    ]),
    element("input", {
      type: "text",
      name: "name",
      id: `${id}-name`,
      value: suggestedName(found, result),
      required: true,
      maxlength: 120,
    }),
    element("button", { type: "submit" }, ["Save as golden case"]),
  ]);
}

/** What saving needs besides the form. */
export interface SaveGoldenContext {
  readonly source: GoldenSource;
  readonly report: EvalRunReport;
  readonly runPage: (fragment: string, saved?: string) => string;
}

/** A thrown error of the builders as the answer it means. */
function answerOfError(error: unknown): EvalUiResponse {
  if (error instanceof GoldenRefusal) return textResponse(error.status, error.message);
  if (error instanceof ScaffoldConflictError) return textResponse(409, error.message);
  if (error instanceof ScaffoldError) return textResponse(400, error.message);
  throw error;
}

/** The form's name, execution and run of the report; undefined when one is missing. */
function goldenFormFieldsOf(report: EvalRunReport, form: URLSearchParams) {
  const name = (form.get("name") ?? "").trim();
  const executionId = form.get("executionId") ?? "";
  const run = formRunOf(report, form.get("run") ?? "");
  return name === "" || executionId === "" || run === undefined
    ? undefined
    : { name, executionId, run };
}

/** `POST /runs/<file>/golden`: the run's execution as a new case of the suite, or why not. */
export async function saveGoldenCase(
  context: SaveGoldenContext,
  form: URLSearchParams,
): Promise<EvalUiResponse> {
  const { source, report } = context;
  if (source.kind === "off")
    return textResponse(409, `cannot save a golden case: ${source.reason}`);
  const fields = goldenFormFieldsOf(report, form);
  if (fields === undefined)
    return textResponse(400, "the form needs a name, a run of this report and its execution");
  const { name, executionId, run } = fields;
  try {
    const before = evalSuiteSourceOf(source.root, {
      application: source.application,
      suite: report.suite,
    });
    if (etagOf(before.file.content) !== form.get("etag"))
      return textResponse(
        409,
        `${before.file.path} changed since this page was made: reload it and save again`,
      );
    const draft = await goldenDraftOf(
      { history: source.history, suite: report.suite, file: before.file },
      run,
      executionId,
      name,
    );
    const plan = planEvalCase(source.root, draft, {
      application: source.application,
      suite: report.suite,
    });
    for (const file of plan.changes.modify)
      writeAtomically(join(source.root, file.path), file.content);
    return seeOther(context.runPage(runAnchor(run.caseIndex, run.result.run), name));
  } catch (error) {
    return answerOfError(error);
  }
}
