import type { TimeSpan } from "../units/working-time.js";
import { questionUsesOf, agentQuestionUsesOf } from "./question-uses.js";
import { withChildWorkflows, flowClassesOf } from "../flow/analyse/child-workflow.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import type { Class } from "../components/injection.js";
import { ComponentError, componentOf } from "../components/metadata.js";
import type { PromptLoader } from "../components/prompt-render.js";
import { ToolCallApprovalDecisionDto } from "../dto/standard/framework.js";
import type { DtoClass } from "../dto/types.js";
import { pauseTargetOf } from "./pause-targets.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { kebabNameProblem } from "../flow/names.js";
import { isDecisionModel } from "../models/decision-models.js";
import { componentModelOf, type ModelResolver } from "../models/model-resolver.js";
import {
  channelRoleOf,
  channelRoleOptionsOf,
  isCodeReplyInterpreter,
  isQuestionRole,
  type ChannelQuestionRoleOptions,
  replyInterpreterOf,
  type FoundChannelRole,
  type ReplyInterpreterDeclaration,
} from "./channel-role.decorator.js";

/**
 * Channels are found from the graph (#267 AC9), like services through `deps`: every tool of every
 * agent of the workflows and of the child workflows they launch names its channel — a concrete
 * `@Channel` (used as is) or a `@ChannelRole` (its implementation comes from the application) —
 * and every question step (#659) is its question role.
 */

/** One tool that names a channel, or one question step (#659). */
export interface ChannelUse {
  /** The tool's `name`; a question step's: its node's, the role's name. */
  readonly tool: string;
  /** The tool's input DTO: what an approval role's `approves` must be; a question's: its `ask`. */
  readonly toolInput: DtoClass;
  /** The class the tool names: a role or a concrete channel. */
  readonly channel: Class;
  /** The workflow whose agent has the tool, or whose flow asks the question. */
  readonly workflow: string;
  /** A question step (`.toExternalTask(Role)`, #659), not a tool — or an agent's question call (#712). */
  readonly isQuestion?: true;
  /** The agent that asks it through its tool loop (#712); absent for a question step. */
  readonly askedBy?: string;
  /** The tool's `expiresIn`, or the question step's (#941): over the role's; absent — the role's. */
  readonly expiresIn?: TimeSpan;
}

interface ToolChannel {
  readonly name: string;
  readonly input: DtoClass;
  readonly channel?: Class;
  readonly expiresIn?: TimeSpan | undefined;
}

/** A tool class's name, input and channel; `undefined` for a class that is not a tool. */
function toolChannelOf(cls: Class): ToolChannel | undefined {
  const component = componentOf(cls);
  if (component?.kind !== "tool") return undefined;
  return component.meta;
}

/** The tools of the agents a workflow's flow names. */
function toolsOfWorkflow(workflow: Class): readonly Class[] {
  const declaration = declarationOf(workflow);
  if (declaration?.kind !== NodeKind.Workflow) return [];
  return flowClassesOf(declaration.options.flow).flatMap((node) => {
    const agent = declarationOf(node);
    return agent?.kind === NodeKind.Agent ? (agent.options.tools ?? []) : [];
  });
}

/**
 * Every tool with a channel in the workflows and their children, each tool once per workflow, and
 * every question step (#659).
 */
export function channelUsesOf(workflows: readonly Class[]): readonly ChannelUse[] {
  return withChildWorkflows(workflows).flatMap((workflow) => {
    const name = declarationOf(workflow)?.options.name ?? workflow.name;
    const tools = [...new Set(toolsOfWorkflow(workflow))].flatMap((cls): readonly ChannelUse[] => {
      const tool = toolChannelOf(cls);
      if (tool?.channel === undefined) return [];
      const { expiresIn } = tool;
      return [
        {
          tool: tool.name,
          toolInput: tool.input,
          channel: tool.channel,
          workflow: name,
          ...(expiresIn === undefined ? {} : { expiresIn }),
        },
      ];
    });
    return [...tools, ...questionUsesOf(workflow, name), ...agentQuestionUsesOf(workflow, name)];
  });
}

/** The question role options of a class an agent lists in its tools (#712); `undefined` for any other. */
export function questionRoleOf(cls: Class): ChannelQuestionRoleOptions | undefined {
  const options = channelRoleOptionsOf(cls);
  return options !== undefined && isQuestionRole(options) ? options : undefined;
}

/** Whether the class is a `@ChannelRole` itself (abstract: its implementation is looked up). */
export const isChannelRole = (cls: Class): boolean => channelRoleOptionsOf(cls) !== undefined;

/** The name a channel class is known by: its role's (for a role) or its `@Channel` name. */
export function channelNameOf(cls: Class): string {
  const role = channelRoleOptionsOf(cls);
  if (role !== undefined) return role.name;
  const component = componentOf(cls);
  if (component?.kind === "channel") return component.meta.name;
  throw new ComponentError({
    message: `${cls.name || "(anonymous class)"} is named as a tool's channel but is neither a @Channel nor a @ChannelRole`,
  });
}

/** The roles the uses name (each once), with their options. */
export function rolesOf(uses: readonly ChannelUse[]): readonly FoundChannelRole[] {
  const found = new Map<Class, FoundChannelRole>();
  for (const use of uses) {
    const role = channelRoleOf(use.channel);
    if (role !== undefined) found.set(role.role, role);
  }
  return [...found.values()];
}

/**
 * The reply interpreters of a workflow's tree (#267 PR 3): the `replyInterpreter` of every channel
 * role its tools — its children's too — name, checked at assembly (`[name.kind-suffix]`,
 * `[reply-interpreter.not-an-interpreter]`, `[reply-interpreter.decision-model]` — a decision model
 * for a question role, whose answer needs more than `approved` —,
 * `[reply-interpreter.no-interpret-method]`) and kept with what they answer and, for a model
 * interpreter, its instructions loaded.
 */

/** One role's interpreter as the workflow runs it. */
export interface AssembledReplyInterpreter {
  /** The role's name: what a pause record names as its `channel`. */
  readonly channel: string;
  /** The interpreter class (a code one is created by the container). */
  readonly interpreter: Class;
  readonly name: string;
  /** What its answer is validated as: `ToolCallApprovalDecisionDto`, or a question role's `answer`. */
  readonly answer: DtoClass;
  /**
   * The input of the tools the role approves: what `overrideArguments` is (#648); `undefined` for a
   * question role (#659).
   */
  readonly approves: DtoClass | undefined;
  /** A model interpreter's model (a chat model, or a decision model for an approval); `undefined` for a code one. */
  readonly model: string | undefined;
  /** The `name` of the `@ModelProvider` the cascade resolved its model to (#1313). */
  readonly modelProvider?: string;
  /** The provider has no `cost`: its calls are `CostSource.Unpriced` (#1313). */
  readonly unpriced?: true;
  /** A model interpreter's instructions (`prompt` / `promptUrls`, static); `""` for a code one. */
  readonly instructions: string;
}

/** A role with an interpreter that `@ReplyInterpreter` describes. */
interface InterpretedRole {
  readonly role: FoundChannelRole;
  readonly interpreter: Class;
  readonly declaration: ReplyInterpreterDeclaration;
}

const nameOf = (cls: Class): string => cls.name || "(anonymous class)";

/** The answer a role's interpreter gives: a question role's `answer`, else an approval decision. */
const answerOf = (role: FoundChannelRole): DtoClass =>
  isQuestionRole(role.options) ? role.options.answer : ToolCallApprovalDecisionDto;

/** The roles of the uses that name an interpreter, each with it (an undecorated one has none). */
export function interpretedRolesOf(uses: readonly ChannelUse[]): readonly InterpretedRole[] {
  return rolesOf(uses).flatMap((role) => {
    const interpreter = role.options.replyInterpreter;
    const declaration = interpreter === undefined ? undefined : replyInterpreterOf(interpreter);
    return interpreter === undefined || declaration === undefined
      ? []
      : [{ role, interpreter, declaration }];
  });
}

/** What is wrong with one interpreter's declaration. */
function declarationViolations({
  role,
  interpreter,
  declaration,
}: InterpretedRole): RuleViolation[] {
  const { options } = declaration;
  const suffix = kebabNameProblem(options.name, "@ReplyInterpreter");
  const found =
    suffix === undefined ? [] : [violation(suffix.code, suffix.message, [options.name])];
  if (isCodeReplyInterpreter(options)) {
    const interpret: unknown = Reflect.get(interpreter.prototype as object, "interpret");
    if (typeof interpret === "function") return found;
    const message = `${nameOf(interpreter)} (${options.name}) is decided by code but has no interpret(input) method — add interpret(input), or give it a model and a prompt`;
    const code =
      declaration.isChannelInterpreter === true
        ? "channel-interpreter.no-interpret-method"
        : "reply-interpreter.no-interpret-method";
    return [...found, violation(code, message, [options.name])];
  }
  // a decision model answers yes / no: an approval's `approved` only (#267 S124 a)
  if (
    options.model === undefined ||
    !isDecisionModel(options.model) ||
    !isQuestionRole(role.options)
  )
    return found;
  const answer = nameOf(answerOf(role));
  const message = `${options.name}: ${options.model} is a decision model — it answers only yes / no (approved), but channel role ${role.options.name} asks for ${answer}, whose fields a yes / no cannot give; name a chat model, or decide by code (DecidedBy.Code)`;
  return [...found, violation("reply-interpreter.decision-model", message, [options.name])];
}

/** Every interpreter rule over a workflow's channel uses. */
export function replyInterpreterViolations(uses: readonly ChannelUse[]): RuleViolation[] {
  const undecorated = rolesOf(uses).flatMap(({ options, role }) => {
    const interpreter = options.replyInterpreter;
    if (interpreter === undefined || replyInterpreterOf(interpreter) !== undefined) return [];
    const message = `channel role ${options.name} names ${nameOf(interpreter)} as its interpreter, but it has no @ChannelInterpreter (@ReplyInterpreter) — decorate it`;
    const code =
      pauseTargetOf(role) === undefined
        ? "reply-interpreter.not-an-interpreter"
        : "channel-interpreter.not-an-interpreter";
    return [violation(code, message, [options.name])];
  });
  return [...undecorated, ...interpretedRolesOf(uses).flatMap(declarationViolations)];
}

/** One role's interpreter as the tree's reader runs it, a model one's instructions loaded by `loader`. */
export async function assembledOf(
  { role, interpreter, declaration }: InterpretedRole,
  loader: PromptLoader,
  resolver?: ModelResolver,
): Promise<AssembledReplyInterpreter> {
  const { options, source } = declaration;
  const label = `@ReplyInterpreter "${options.name}"`;
  const base = {
    channel: role.options.name,
    interpreter,
    name: options.name,
    answer: answerOf(role),
    approves: role.options.approves,
  };
  if (isCodeReplyInterpreter(options)) return { ...base, model: undefined, instructions: "" };
  // its model through the cascade: the interpreter's own provider, its workflow's, its application's (#1313)
  const own = { model: options.model, provider: options.modelProvider, isRequired: true };
  return {
    ...base,
    ...componentModelOf(resolver, `replyInterpreters.${options.name}`, own),
    instructions: await loader.load({ label, options, source, variables: options.promptVariables }),
  };
}

/** The interpreters of a workflow's tree, model ones with their instructions loaded by `loader`. */
export async function replyInterpretersOf(
  workflow: Class,
  loader: PromptLoader,
  resolver?: ModelResolver,
): Promise<readonly AssembledReplyInterpreter[]> {
  const roles = interpretedRolesOf(channelUsesOf([workflow]));
  return Promise.all(roles.map((role) => assembledOf(role, loader, resolver)));
}

/** The code interpreters among them: the classes the container creates. */
export const codeInterpreterClassesOf = (
  interpreters: readonly AssembledReplyInterpreter[],
): readonly Class[] =>
  interpreters.flatMap((found) => (found.model === undefined ? [found.interpreter] : []));
