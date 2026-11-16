import { violation, type RuleViolation } from "../graph/rule-error.js";
import type { AssembledWorkflow } from "../workflow.js";
import { hasFileAtAnyDepth } from "../a2a/files/a2a-file.dto.js";
import { NodeKind } from "../flow/ast.js";
import { classesOf } from "../flow/runtime/answer-tools.js";
import { hasModelForm } from "./file-needs.js";
import type { ResolvedModelFiles } from "./file-settings.js";
import { AnswerFiles, FileSource, FileView } from "./model-files.js";

/**
 * The assembly rules of an agent's files (#899): reported with all the others, never thrown when a
 * decorator runs. `[files.invalid-setting]` for a setting that cannot work, `[files.no-redactor]` for a
 * redacted view nothing listed can make, `[pii.original-file]` for the original file under a PII policy.
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
 * Interim rule (#899 PR 1, removed by PR 2): input guardrails read text only, so file parts must not
 * reach a model past them. An agent whose files can produce a part (the input's, or a tool result's
 * while they are guarded) and that has an input guardrail does not start. PR 1 lets no answer file
 * through (`answerFiles` is read nowhere), so output guardrails need no such rule.
 */
function unguardedFileProblem(files: ResolvedModelFiles, hasInputGuardrail: boolean): string[] {
  const producesParts =
    files.sources.includes(FileSource.Input) ||
    (files.sources.includes(FileSource.ToolResults) && files.guardToolResultFiles);
  return hasInputGuardrail && producesParts
    ? [
        "input guardrails read text only: guardrails on files come with #899 PR 2 - remove the input guardrails, or the Input and ToolResults sources",
      ]
    : [];
}

/** What an applying PII policy rules out: the original file, and (until PR 2) the transcription. */
function piiViolations(
  name: string,
  files: ResolvedModelFiles,
  workflow: AssembledWorkflow,
): RuleViolation[] {
  if ((workflow.pii?.byElement.get(name) ?? []).length === 0) return [];
  const found: RuleViolation[] = [];
  if (files.views.includes(FileView.Original))
    found.push(
      violation(
        "pii.original-file",
        `${name}: FileView.Original sends the file to its model unmasked while PII policies apply to it — use FileView.Transcription, or exclude the policies`,
        [name],
      ),
    );
  if (files.views.includes(FileView.Transcription))
    found.push(
      violation(
        "files.invalid-setting",
        `${name}: FileView.Transcription under PII policies is not supported yet - a transcript is kept unmasked in the execution's state; masked transcripts come with #899 PR 2`,
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
  const hasInputGuardrail = (workflow.guardrails?.byElement.get(name)?.input ?? []).length > 0;
  const invalid = [
    ...listProblems(files),
    ...numberProblems(files),
    ...typeProblems(files),
    ...unguardedFileProblem(files, hasInputGuardrail),
  ].map((problem) => violation("files.invalid-setting", `${name}: files — ${problem}`, [name]));
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
 * Interim rule (#899 PR 1, removed by PR 2 with `AnswerFiles`): an agent whose output DTO has file
 * fields would be handed the raw schema, so its model could make up inline bytes or urls that
 * travel to later steps and artifacts unchecked.
 */
function answerFileViolations(name: string, workflow: AssembledWorkflow): RuleViolation[] {
  const declaration = workflow.graph.nodes.get(name)?.declaration;
  if (declaration?.kind !== NodeKind.Agent) return [];
  const { output } = declaration.options;
  const hasFileField =
    output !== undefined && classesOf(output).some((dto) => hasFileAtAnyDepth(dto));
  return hasFileField
    ? [
        violation(
          "files.invalid-setting",
          `${name}: an agent's output with file fields is not supported yet - files an agent hands back come with #899 PR 2 (AnswerFiles)`,
          [name],
        ),
      ]
    : [];
}

/** Every rule of every agent's files in the application's workflows. */
export const filesViolations = (workflows: readonly AssembledWorkflow[]): RuleViolation[] =>
  workflows.flatMap((workflow) =>
    Object.entries(workflow.config.agents).flatMap(([name, settings]) => [
      ...(settings.files === undefined ? [] : agentViolations(name, settings.files, workflow)),
      ...answerFileViolations(name, workflow),
    ]),
  );
