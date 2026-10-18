import type { DtoClass } from "../dto/types.js";

/**
 * Name rules (#272 → Names, #270 → DTOs): every component `name` is kebab-case and ends with its
 * kind (`main-router`, `draft-agent`, `chat-workflow-start`, `order-status-tool`); every DTO class
 * ends with `Dto`. Pure checks — the analyser (PR 2) reports them, all at once, at assembly.
 */

/** What a named component is; each value is the suffix its `name` ends with. */
export enum NameKind {
  WorkflowStart = "workflow-start",
  WorkflowFinish = "workflow-finish",
  Workflow = "workflow",
  Agent = "agent",
  Action = "action",
  Router = "router",
  Tool = "tool",
  Application = "application",
  Budget = "budget",
}

/** The decorator each kind is declared with, as a message names it. */
const DECORATORS: Readonly<Record<NameKind, string>> = {
  [NameKind.WorkflowStart]: "@WorkflowStart",
  [NameKind.WorkflowFinish]: "@WorkflowFinish",
  [NameKind.Workflow]: "@Workflow",
  [NameKind.Agent]: "@Agent",
  [NameKind.Action]: "@Action",
  [NameKind.Router]: "@Router",
  [NameKind.Tool]: "@Tool",
  [NameKind.Application]: "@Application",
  [NameKind.Budget]: "@Budget",
};

/** The stable codes of the name rules. */
export type NameRuleCode = "name.kind-suffix" | "dto.name";

/** A broken name rule: its code and what to do (the analyser prefixes `[code]`). */
export interface NameProblem {
  readonly code: NameRuleCode;
  readonly message: string;
}

const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The class-name suffix of a DTO. */
export const DTO_SUFFIX = "Dto";

/** Whether a name is kebab-case: lowercase words joined by single dashes. */
export function isKebabCase(name: string): boolean {
  return KEBAB_CASE.test(name);
}

/** A name in kebab-case: `ScoreSummary`, `score_summary`, `Score Summary` → `score-summary`. */
export function toKebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Whether `name` is kebab-case and ends with its kind (`-agent`), with words before it. */
export function hasKindSuffix(name: string, kind: NameKind): boolean {
  return isKebabCase(name) && name.endsWith(`-${kind}`);
}

/** The name to suggest: kebab-case, ending with the kind. */
export function suggestedName(name: string, kind: NameKind): string {
  const kebab = toKebabCase(name);
  return hasKindSuffix(kebab, kind) ? kebab : `${kebab}-${kind}`;
}

/** `[name.kind-suffix] "score-summary" on @Agent — name it "score-summary-agent"`, or nothing. */
export function kindSuffixProblem(name: string, kind: NameKind): NameProblem | undefined {
  if (hasKindSuffix(name, kind)) return undefined;
  return {
    code: "name.kind-suffix",
    message: `"${name}" on ${DECORATORS[kind]} — name it "${suggestedName(name, kind)}"`,
  };
}

/** The name of a class as a message shows it. */
const classNameOf = (dto: DtoClass): string => dto.name || "(anonymous class)";

/** `[dto.name] Critique is a DTO — name it CritiqueDto`, or nothing. */
export function dtoNameProblem(dto: DtoClass): NameProblem | undefined {
  const name = classNameOf(dto);
  if (name.length > DTO_SUFFIX.length && name.endsWith(DTO_SUFFIX)) return undefined;
  return { code: "dto.name", message: `${name} is a DTO — name it ${name}${DTO_SUFFIX}` };
}
