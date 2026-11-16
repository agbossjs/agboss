import { violation, type RuleViolation } from "../graph/rule-error.js";
import type { AssembledWorkflow } from "../workflow.js";
import { fileActionOf, isCustomPolicy, PiiFileAction } from "../pii/pii-policy.decorator.js";
import { piiPolicyMetaOf } from "../pii/policy-checks.js";
import { hasModelForm } from "./file-needs.js";
import { answersWithFiles } from "./file-readers.js";
import type { ResolvedModelFiles } from "./file-settings.js";
import { AnswerFiles, FileSource, FileView } from "./model-files.js";

/**
 * The assembly rules of an agent's files (#899): reported with all the others, never thrown when a
 * decorator runs. `[files.invalid-setting]` for a setting that cannot work, `[files.no-redactor]` for a
 * redacted view nothing listed can make, `[pii.original-file]` for the original file under a PII policy that
 * does not let it through, `[pii.redacted-needs-kinds]` for a redacted view under a policy of a project's own
 * detector, `[files.answer-file-unseen]` for an answer file the agent cannot have seen.
 */

const isWhole = (value: number, min: number): boolean => Number.isInteger(value) && value >= min;

const isMember = <T extends string>(all: Record<string, T>, value: unknown): boolean =>
  Object.values(all).some((member) => member === value);

/** What is wrong with an agent's sources and views. */
function listProblems(files: ResolvedModelFiles): string[] {
  const problems: string[] = [];
  if (files.sources.length === 0) problems.push("sources is empty");
  if (files.views.length === 0) problems.push("views is empty");
  for (const source of files.sources) {
    if (!isMember(FileSource, source)) problems.push(`sources has "${source}"`);
    else if (source === FileSource.History)
      problems.push("FileSource.History is not read yet: use FileSource.Input or ToolResults");
  }
  for (const view of files.views)
    if (!isMember(FileView, view)) problems.push(`views has "${view}"`);
  return problems;
}

/** What is wrong with the numbers of one agent's settings. */
function numberProblems(files: ResolvedModelFiles): string[] {
  const problems: string[] = [];
  if (!isWhole(files.maxFileSize, 1))
    problems.push("maxFileSize is not a whole number of bytes from 1");
  if (!isWhole(files.maxTotalFileSize, 1))
    problems.push("maxTotalFileSize is not a whole number of bytes from 1");
  if (!isWhole(files.maxFiles, 1)) problems.push("maxFiles is not a whole number from 1");
  if (files.maxFileSize > files.maxTotalFileSize)
    problems.push("maxFileSize is larger than maxTotalFileSize: raise maxTotalFileSize");
  if (!isMember(AnswerFiles, files.answerFiles)) problems.push("answerFiles is not an AnswerFiles");
  return problems;
}

/** What is wrong with the media types an agent's files are allowed. */
function typeProblems(files: ResolvedModelFiles): string[] {
  if (files.allowedMediaTypes.length === 0) return ["allowedMediaTypes is empty"];
  if (!files.isTypesExplicit) return [];
  return files.allowedMediaTypes
    .filter((type) => !hasModelForm(type))
    .map((type) => `allowedMediaTypes has ${type}: a model reads text, images and PDFs as files`);
}

/**
 * What an agent's applying PII policies rule out (#899 §5): the original file unless every policy
 * lets it through, and a redacted view when a policy is a project's own detector — it reads text, so
 * no redactor can know what to black out.
 */
function piiViolations(
  name: string,
  files: ResolvedModelFiles,
  workflow: AssembledWorkflow,
): RuleViolation[] {
  const policies = (workflow.pii?.byElement.get(name) ?? []).flatMap((cls) => {
    const meta = piiPolicyMetaOf(cls);
    return meta === undefined ? [] : [meta];
  });
  if (policies.length === 0) return [];
  const found: RuleViolation[] = [];
  const masking = policies.filter((meta) => fileActionOf(meta) !== PiiFileAction.AllowOriginal);
  if (files.views.includes(FileView.Original) && masking.length > 0)
    found.push(
      violation(
        "pii.original-file",
        `${name}: FileView.Original sends the file to its model unmasked while ${masking.map((meta) => meta.name).join(", ")} apply to it — use FileView.Transcription, set files: PiiFileAction.AllowOriginal on the policy, or exclude the policy`,
        [name],
      ),
    );
  const custom = policies.filter(isCustomPolicy);
  if (files.views.includes(FileView.Redacted) && custom.length > 0)
    found.push(
      violation(
        "pii.redacted-needs-kinds",
        `${name}: FileView.Redacted needs the kinds a policy names, and ${custom.map((meta) => meta.name).join(", ")} reads text with its own detector — use FileView.Transcription (it works with it), or a policy with rules`,
        [name],
      ),
    );
  return found;
}

/** The rules of one agent's resolved files. */
function agentViolations(
  name: string,
  files: ResolvedModelFiles,
  workflow: AssembledWorkflow,
): RuleViolation[] {
  const invalid = [...listProblems(files), ...numberProblems(files), ...typeProblems(files)].map(
    (problem) => violation("files.invalid-setting", `${name}: files — ${problem}`, [name]),
  );
  if (files.views.includes(FileView.Redacted))
    invalid.push(
      violation(
        "files.no-redactor",
        `${name}: FileView.Redacted needs a FileRedactor that supports its media types — none can be listed yet`,
        [name],
      ),
    );
  invalid.push(...piiViolations(name, files, workflow));
  return invalid;
}

/**
 * An agent whose answer has file fields hands back only files it saw (`AnswerFiles.SeenInVisit`, the
 * default), as the views its model saw: one it saw only as a transcription cannot be returned — and an
 * agent that reads no file saw none. `AnswerFiles.Any` (the developer's explicit decision) is checked
 * at run time instead.
 */
function answerFileViolations(
  name: string,
  files: ResolvedModelFiles | undefined,
  workflow: AssembledWorkflow,
): RuleViolation[] {
  if (!answersWithFiles(workflow.graph, name)) return [];
  if (files?.answerFiles === AnswerFiles.Any) return [];
  const isReturnable = files?.views.some((view) => view !== FileView.Transcription) === true;
  if (isReturnable) return [];
  return [
    violation(
      "files.answer-file-unseen",
      files === undefined
        ? `${name}: its answer has file fields, but it reads no file — give it files: ModelFiles.of({ … }) (or answerFiles: AnswerFiles.Any, the model's own descriptors, checked at run time)`
        : `${name}: its answer has file fields, but its only view of a file is its transcription — add FileView.Original (or Redacted), or set answerFiles: AnswerFiles.Any`,
      [name],
    ),
  ];
}

/** Every rule of every agent's files in the application's workflows. */
export const filesViolations = (workflows: readonly AssembledWorkflow[]): RuleViolation[] =>
  workflows.flatMap((workflow) =>
    Object.entries(workflow.config.agents).flatMap(([name, settings]) => [
      ...(settings.files === undefined ? [] : agentViolations(name, settings.files, workflow)),
      ...answerFileViolations(name, settings.files, workflow),
    ]),
  );
