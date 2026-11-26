import type { FlowNodeKind } from "../ast.js";
import type { ComponentKind } from "../runtime/records.js";
import type { Class } from "../../components/injection.js";
import type { SourceSpan } from "../../core/diagnostics/source-span.js";
import type { DtoClass } from "../../dto/types.js";
import {
  isWrapper,
  type HistoryWrapper,
  type ListWrapper,
  type OptionalWrapper,
} from "../dto-wrappers.js";
import type { QuestionNodeOptions } from "../../channels/pause-targets.js";
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

/** A declaration of one kind: the options as written and the declaring file (a `prompt` path is read next to it). */
export interface Declared<TKind extends FlowNodeKind, TOptions> {
  readonly kind: TKind;
  readonly options: TOptions;
  /** The file the decorator was called from (the class's file); absent when it cannot be told. */
  readonly source?: string;
  /** Where the decorator was called in that file (#1325c): what a rendered diagnostic underlines. */
  readonly span?: SourceSpan;
}

export type WorkflowStartDeclaration = Declared<ComponentKind.WorkflowStart, WorkflowStartOptions>;
export type WorkflowFinishDeclaration = Declared<
  ComponentKind.WorkflowFinish,
  WorkflowFinishOptions
>;
export type AgentDeclaration = Declared<ComponentKind.Agent, AgentOptions>;
export type ActionDeclaration = Declared<ComponentKind.Action, ActionOptions>;
export type RouterDeclaration = Declared<ComponentKind.Router, RouterOptions>;
export type WorkflowDeclaration = Declared<ComponentKind.Workflow, WorkflowOptions>;
/** A question role as its step's node (#659): recorded by `@ChannelRole({ ask, answer })`. */
export type QuestionDeclaration = Declared<ComponentKind.ExternalTask, QuestionNodeOptions>;

/** What any v2 decorator recorded. */
export type ComponentDeclaration =
  | WorkflowStartDeclaration
  | WorkflowFinishDeclaration
  | AgentDeclaration
  | ActionDeclaration
  | RouterDeclaration
  | WorkflowDeclaration
  | QuestionDeclaration;

const declarations = new WeakMap<object, ComponentDeclaration>();

/** The classes a name stands for — a component's `name` or its class's name (#1325c): rules name nodes by it. */
const classesByName = new Map<string, Set<Class>>();

/** Called by the v2 decorators. */
export function recordDeclaration(target: Class, declaration: ComponentDeclaration): void {
  declarations.set(target, declaration);
  const options: unknown = declaration.options;
  const named: unknown =
    typeof options === "object" && options !== null ? Reflect.get(options, "name") : "";
  for (const name of [target.name, typeof named === "string" ? named : ""]) {
    if (name === "") continue;
    classesByName.set(name, (classesByName.get(name) ?? new Set()).add(target));
  }
}

/** The one class a component name or a class name stands for; none when it stands for none or for several. */
export function componentClassOfName(name: string): Class | undefined {
  const classes = classesByName.get(name);
  const [only] = classes?.size === 1 ? classes : [];
  return only;
}

/** What a v2 decorator recorded on a class; undefined for an undecorated one (or no class). */
export function declarationOf(target: object): ComponentDeclaration | undefined {
  return declarations.get(target);
}

/** A declaration with the declaring file when it is known. */
export function declared<TKind extends FlowNodeKind, TOptions>(
  kind: TKind,
  options: TOptions,
  source: string | undefined,
  span?: SourceSpan,
): Declared<TKind, TOptions> {
  return {
    kind,
    options,
    ...(source === undefined ? {} : { source }),
    ...(span === undefined ? {} : { span }),
  };
}
