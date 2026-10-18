import type { Class } from "../../components/injection.js";
import type { DtoClass } from "../../dto/types.js";
import type { NodeKind } from "../ast.js";
import {
  isWrapper,
  type HistoryWrapper,
  type ListWrapper,
  type OptionalWrapper,
} from "../dto-wrappers.js";
import type { ActionOptions } from "./action.js";
import type { AgentOptions } from "./agent.js";
import type { RouterOptions } from "./router.js";
import type { WorkflowFinishOptions } from "./workflow-finish.js";
import type { WorkflowOptions } from "./workflow.js";
import type { WorkflowStartOptions } from "./workflow-start.js";

/**
 * What a v2 decorator records about a class: its kind, its options exactly as written, and the
 * file it is declared in. Components declare types only (#270): no producer is named anywhere.
 */

/**
 * One input field's type: `XDto`, `optional(…)`, `listOf(…)` or `historyOf(XDto)` (the current value
 * and its earlier versions, #299) — a type, never a producer.
 */
export type InputFieldShape = DtoClass | ListWrapper | OptionalWrapper | HistoryWrapper;

/** A component's `input`: field name → its type (`{ draft: OfferDraftDto, legal: optional(…) }`). */
export type InputFields = Readonly<Record<string, InputFieldShape>>;

/** Whether a start's `input` is a map of fields (not one DTO, not a list). */
export const isFieldMap = <TFields extends InputFields>(
  input: DtoClass | ListWrapper | TFields,
): input is TFields => typeof input !== "function" && !isWrapper(input);

/** A declaration of one kind: the options as written and the declaring file (`promptUrls`, …). */
export interface Declared<TKind extends NodeKind, TOptions> {
  readonly kind: TKind;
  readonly options: TOptions;
  /** The file the decorator was called from (the class's file); absent when it cannot be told. */
  readonly source?: string;
}

export type WorkflowStartDeclaration = Declared<NodeKind.Start, WorkflowStartOptions>;
export type WorkflowFinishDeclaration = Declared<NodeKind.Finish, WorkflowFinishOptions>;
export type AgentDeclaration = Declared<NodeKind.Agent, AgentOptions>;
export type ActionDeclaration = Declared<NodeKind.Action, ActionOptions>;
export type RouterDeclaration = Declared<NodeKind.Router, RouterOptions>;
export type WorkflowDeclaration = Declared<NodeKind.Workflow, WorkflowOptions>;

/** What any v2 decorator recorded. */
export type ComponentDeclaration =
  | WorkflowStartDeclaration
  | WorkflowFinishDeclaration
  | AgentDeclaration
  | ActionDeclaration
  | RouterDeclaration
  | WorkflowDeclaration;

const declarations = new WeakMap<Class, ComponentDeclaration>();

/** Called by the v2 decorators. */
export function recordDeclaration(target: Class, declaration: ComponentDeclaration): void {
  declarations.set(target, declaration);
}

/** What a v2 decorator recorded on a class; undefined for an undecorated one. */
export function declarationOf(target: Class): ComponentDeclaration | undefined {
  return declarations.get(target);
}

/** A declaration with the declaring file when it is known. */
export function declared<TKind extends NodeKind, TOptions>(
  kind: TKind,
  options: TOptions,
  source: string | undefined,
): Declared<TKind, TOptions> {
  return source === undefined ? { kind, options } : { kind, options, source };
}
