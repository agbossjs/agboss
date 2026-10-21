import { withChildWorkflows, flowClassesOf } from "../flow/analyse/child-workflow.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import type { Class } from "../components/injection.js";
import { ComponentError, componentOf } from "../components/metadata.js";
import type { PromptLoader } from "../components/prompt-render.js";
import { ToolCallApprovalDecisionDto } from "../dto/standard/framework.js";
import type { DtoClass } from "../dto/types.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { isDecisionModel } from "../models/decision-models.js";
import { kindSuffixProblem, NameKind } from "../flow/names.js";
import {
  channelRoleOf,
  channelRoleOptionsOf,
  isCodeReplyInterpreter,
  replyInterpreterOf,
  type FoundChannelRole,
  type ReplyInterpreterDeclaration,
} from "./channel-role.decorator.js";

/**
 * Channels are found from the graph (#267 AC9), like services through `deps`: every tool of every
 * agent of the workflows and of the child workflows they launch names its channel — a concrete
 * `@Channel` (used as is) or a `@ChannelRole` (its implementation comes from the application).
 */

/** One tool that names a channel. */
export interface ChannelUse {
  /** The tool's `name`. */
  readonly tool: string;
  /** The tool's input DTO: what an approval role's `approves` must be. */
  readonly toolInput: DtoClass;
  /** The class the tool names: a role or a concrete channel. */
  readonly channel: Class;
  /** The workflow whose agent has the tool. */
  readonly workflow: string;
}

interface ToolChannel {
  readonly name: string;
  readonly input: DtoClass;
  readonly channel?: Class;
}

/** A tool class's name, input and channel; `undefined` for a class that is not a tool. */
function toolChannelOf(cls: Class): ToolChannel | undefined {
  const component = componentOf(cls);
  if (component?.kind !== "tool" && component?.kind !== "mcp-tool") return undefined;
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

/** Every tool with a channel in the workflows and their children, each tool once per workflow. */
export function channelUsesOf(workflows: readonly Class[]): readonly ChannelUse[] {
  return withChildWorkflows(workflows).flatMap((workflow) => {
    const name = declarationOf(workflow)?.options.name ?? workflow.name;
    return [...new Set(toolsOfWorkflow(workflow))].flatMap((cls): readonly ChannelUse[] => {
      const tool = toolChannelOf(cls);
      if (tool?.channel === undefined) return [];
      return [{ tool: tool.name, toolInput: tool.input, channel: tool.channel, workflow: name }];
    });
  });
}

/** Whether the class is a `@ChannelRole` itself (abstract: its implementation is looked up). */
export const isChannelRole = (cls: Class): boolean => channelRoleOptionsOf(cls) !== undefined;

/** The name a channel class is known by: its role's (for a role) or its `@Channel` name. */
export function channelNameOf(cls: Class): string {
  const role = channelRoleOptionsOf(cls);
  if (role !== undefined) return role.name;
  const component = componentOf(cls);
  if (component?.kind === "channel") return component.meta.name;
  throw new ComponentError(
    `${cls.name || "(anonymous class)"} is named as a tool's channel but is neither a @Channel nor a @ChannelRole`,
  );
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
 * for a question role, whose answer needs more than `approved`,
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
  /** What its answer is validated as: `ToolCallApprovalDecisionDto`, or the role's `answer`. */
  readonly answer: DtoClass;
  /** A model interpreter's model (a chat model, or a decision model for an approval); `undefined` for a code one. */
  readonly model: string | undefined;
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

/** The answer a role's interpreter gives. */
const answerOf = (role: FoundChannelRole): DtoClass =>
  role.options.approves === undefined ? role.options.answer : ToolCallApprovalDecisionDto;

/** The roles of the uses that name an interpreter, each with it (an undecorated one has none). */
function interpretedRolesOf(uses: readonly ChannelUse[]): readonly InterpretedRole[] {
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
  const suffix = kindSuffixProblem(options.name, NameKind.ReplyInterpreter);
  const found =
    suffix === undefined ? [] : [violation(suffix.code, suffix.message, [options.name])];
  if (isCodeReplyInterpreter(options)) {
    const interpret: unknown = Reflect.get(interpreter.prototype as object, "interpret");
    if (typeof interpret === "function") return found;
    const message = `${nameOf(interpreter)} (${options.name}) is decided by code but has no interpret(input) method — implements ReplyInterpreterHandler<${nameOf(interpreter)}>`;
    return [...found, violation("reply-interpreter.no-interpret-method", message, [options.name])];
  }
  // a decision model answers yes / no: an approval's `approved` only (#267 S124 a)
  if (!isDecisionModel(options.model) || role.options.approves !== undefined) return found;
  const answer = nameOf(answerOf(role));
  const message = `${options.name}: ${options.model} is a decision model — it answers only yes / no (approved), but channel role ${role.options.name} asks for ${answer}, whose fields a yes / no cannot give; name a chat model, or decide by code (DecidedBy.Code)`;
  return [...found, violation("reply-interpreter.decision-model", message, [options.name])];
}

/** Every interpreter rule over a workflow's channel uses. */
export function replyInterpreterViolations(uses: readonly ChannelUse[]): RuleViolation[] {
  const undecorated = rolesOf(uses).flatMap(({ options }) => {
    const interpreter = options.replyInterpreter;
    if (interpreter === undefined || replyInterpreterOf(interpreter) !== undefined) return [];
    const message = `channel role ${options.name} names ${nameOf(interpreter)} as its replyInterpreter, but it has no @ReplyInterpreter — decorate it`;
    return [violation("reply-interpreter.not-an-interpreter", message, [options.name])];
  });
  return [...undecorated, ...interpretedRolesOf(uses).flatMap(declarationViolations)];
}

/** The interpreters of a workflow's tree, model ones with their instructions loaded by `loader`. */
export async function replyInterpretersOf(
  workflow: Class,
  loader: PromptLoader,
): Promise<readonly AssembledReplyInterpreter[]> {
  const roles = interpretedRolesOf(channelUsesOf([workflow]));
  return Promise.all(
    roles.map(async ({ role, interpreter, declaration }) => {
      const { options, source } = declaration;
      const isCode = isCodeReplyInterpreter(options);
      const label = `@ReplyInterpreter "${options.name}"`;
      return {
        channel: role.options.name,
        interpreter,
        name: options.name,
        answer: answerOf(role),
        model: isCode ? undefined : options.model,
        instructions: isCode ? "" : await loader.load({ label, options, source }),
      };
    }),
  );
}

/** The code interpreters among them: the classes the container creates. */
export const codeInterpreterClassesOf = (
  interpreters: readonly AssembledReplyInterpreter[],
): readonly Class[] =>
  interpreters.flatMap((found) => (found.model === undefined ? [found.interpreter] : []));
