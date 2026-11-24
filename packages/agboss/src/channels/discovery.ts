import { questionUsesOf, agentQuestionUsesOf } from "./question-uses.js";
import { withChildWorkflows, flowClassesOf } from "../flow/analyse/child-workflow.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import type { Class } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import type { PromptLoader } from "../components/prompt-render.js";
import { ToolCallApprovalDecisionDto } from "../dto/standard/framework.js";
import type { DtoClass } from "../dto/types.js";
import {
  findPauseTarget,
  isExternalTask,
  pauseTargetOf,
  type ExternalTaskOptions,
  type FoundPauseTarget,
} from "./pause-targets.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { kebabNameProblem } from "../flow/names.js";
import { isDecisionModel } from "../models/decision-models.js";
import { componentModelOf, type ModelResolver } from "../models/model-resolver.js";
import {
  channelInterpreterOf,
  isCodeChannelInterpreter,
  type ChannelInterpreterDeclaration,
} from "./channel-interpreter.js";

/**
 * Pause targets are found from the graph (#267 AC9), like services through `deps`: every tool of
 * every agent of the workflows and of the child workflows they launch names its `@ToolApproval`,
 * and every external-task step (#659) is its `@ExternalTask`.
 */

/** One tool that names a pause target, or one external-task step (#659). */
export interface ChannelUse {
  /** The tool's `name`; an external-task step's: its node's, the target's name. */
  readonly tool: string;
  /** The tool's input DTO: what a tool approval's `input` must be; an external task's: its `input`. */
  readonly toolInput: DtoClass;
  /** The class the tool names: its `@ToolApproval`, or the `@ExternalTask` itself. */
  readonly target: Class;
  /** The workflow whose agent has the tool, or whose flow asks the external task. */
  readonly workflow: string;
  /** An external-task step (`.toExternalTask(Task)`, #659), not a tool — or an agent's external-task call (#712). */
  readonly isQuestion?: true;
  /** The agent that asks it through its tool loop (#712); absent for an external-task step. */
  readonly askedBy?: string;
}

interface ToolChannel {
  readonly name: string;
  readonly input: DtoClass;
  readonly approval?: Class;
}

/** A tool class's name, input and approval; `undefined` for a class that is not a tool. */
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
 * Every tool with an approval in the workflows and their children, each tool once per workflow, and
 * every question step (#659).
 */
export function channelUsesOf(workflows: readonly Class[]): readonly ChannelUse[] {
  return withChildWorkflows(workflows).flatMap((workflow) => {
    const name = declarationOf(workflow)?.options.name ?? workflow.name;
    const tools = [...new Set(toolsOfWorkflow(workflow))].flatMap((cls): readonly ChannelUse[] => {
      const tool = toolChannelOf(cls);
      if (tool?.approval === undefined) return [];
      return [{ tool: tool.name, toolInput: tool.input, target: tool.approval, workflow: name }];
    });
    return [...tools, ...questionUsesOf(workflow, name), ...agentQuestionUsesOf(workflow, name)];
  });
}

/** The external task options of a class an agent lists in its tools (#712); `undefined` for any other. */
export function externalTaskOf(cls: Class): ExternalTaskOptions | undefined {
  const options = pauseTargetOf(cls)?.options;
  return options !== undefined && isExternalTask(options) ? options : undefined;
}

/** The targets the uses name (each once), with their options. */
export function targetsOfUses(uses: readonly ChannelUse[]): readonly FoundPauseTarget[] {
  const found = new Map<Class, FoundPauseTarget>();
  for (const use of uses) {
    const target = findPauseTarget(use.target);
    if (target !== undefined) found.set(target.target, target);
  }
  return [...found.values()];
}

/**
 * The channel interpreters of a workflow's tree (#267 PR 3): the `channelInterpreter` of every pause
 * target its tools — its children's too — name, checked at assembly (`[name.kind-suffix]`,
 * `[channel-interpreter.not-an-interpreter]`, `[reply-interpreter.decision-model]` — a decision
 * model for an external task, whose output needs more than `approved` —,
 * `[channel-interpreter.no-interpret-method]`) and kept with what they answer and, for a model
 * interpreter, its instructions loaded.
 */

/** One target's interpreter as the workflow runs it. */
export interface AssembledReplyInterpreter {
  /** The target's name: what a pause record names as its `target`. */
  readonly target: string;
  /** The interpreter class (a code one is created by the container). */
  readonly interpreter: Class;
  readonly name: string;
  /** What its answer is validated as: `ToolCallApprovalDecisionDto`, or an external task's `output`. */
  readonly answer: DtoClass;
  /**
   * The input of the tools the target approves: what `overrideInput` is (#648); `undefined` for an
   * external task (#659) and a tool approval of any tool.
   */
  readonly input: DtoClass | undefined;
  /** A model interpreter's model (a chat model, or a decision model for an approval); `undefined` for a code one. */
  readonly model: string | undefined;
  /** The `name` of the `@ModelProvider` the cascade resolved its model to (#1313). */
  readonly modelProvider?: string;
  /** The provider has no `cost`: its calls are `CostSource.Unpriced` (#1313). */
  readonly unpriced?: true;
  /** A model interpreter's instructions (`prompt`, static); `""` for a code one. */
  readonly instructions: string;
}

/** A target with an interpreter that `@ChannelInterpreter` describes. */
interface InterpretedTarget {
  readonly found: FoundPauseTarget;
  readonly interpreter: Class;
  readonly declaration: ChannelInterpreterDeclaration;
}

const nameOf = (cls: Class): string => cls.name || "(anonymous class)";

/** The answer a target's interpreter gives: an external task's `output`, else an approval decision. */
const answerOf = ({ options }: FoundPauseTarget): DtoClass =>
  isExternalTask(options) ? options.output : ToolCallApprovalDecisionDto;

/** The targets of the uses that name an interpreter, each with it (an undecorated one has none). */
export function interpretedTargetsOf(uses: readonly ChannelUse[]): readonly InterpretedTarget[] {
  return targetsOfUses(uses).flatMap((found) => {
    const interpreter = found.options.channelInterpreter;
    const declaration = interpreter === undefined ? undefined : channelInterpreterOf(interpreter);
    return interpreter === undefined || declaration === undefined
      ? []
      : [{ found, interpreter, declaration }];
  });
}

/** What is wrong with one interpreter's declaration. */
function declarationViolations({
  found: target,
  interpreter,
  declaration,
}: InterpretedTarget): RuleViolation[] {
  const { options } = declaration;
  const suffix = kebabNameProblem(options.name, "@ChannelInterpreter");
  const found =
    suffix === undefined ? [] : [violation(suffix.code, suffix.message, [options.name])];
  if (isCodeChannelInterpreter(declaration)) {
    const interpret: unknown = Reflect.get(interpreter.prototype as object, "interpret");
    if (typeof interpret === "function") return found;
    const message = `${nameOf(interpreter)} (${options.name}) is decided by code but has no interpret(input) method — add interpret(input), or give it a model and a prompt`;
    return [
      ...found,
      violation("channel-interpreter.no-interpret-method", message, [options.name]),
    ];
  }
  // a decision model answers yes / no: an approval's `approved` only (#267 S124 a)
  if (
    options.model === undefined ||
    !isDecisionModel(options.model) ||
    !isExternalTask(target.options)
  )
    return found;
  const answer = nameOf(answerOf(target));
  const message = `${options.name}: ${options.model} is a decision model — it answers only yes / no (approved), but external task ${target.options.name} asks for ${answer}, whose fields a yes / no cannot give; name a chat model, or decide by code`;
  return [...found, violation("reply-interpreter.decision-model", message, [options.name])];
}

/** Every interpreter rule over a workflow's pause-target uses. */
export function replyInterpreterViolations(uses: readonly ChannelUse[]): RuleViolation[] {
  const undecorated = targetsOfUses(uses).flatMap(({ options }) => {
    const interpreter = options.channelInterpreter;
    if (interpreter === undefined || channelInterpreterOf(interpreter) !== undefined) return [];
    const message = `pause target ${options.name} names ${nameOf(interpreter)} as its interpreter, but it has no @ChannelInterpreter — decorate it`;
    return [violation("channel-interpreter.not-an-interpreter", message, [options.name])];
  });
  return [...undecorated, ...interpretedTargetsOf(uses).flatMap(declarationViolations)];
}

/** One target's interpreter as the tree's reader runs it, a model one's instructions loaded by `loader`. */
export async function assembledOf(
  { found, interpreter, declaration }: InterpretedTarget,
  loader: PromptLoader,
  resolver?: ModelResolver,
): Promise<AssembledReplyInterpreter> {
  const { options, source } = declaration;
  const label = `@ChannelInterpreter "${options.name}"`;
  const base = {
    target: found.options.name,
    interpreter,
    name: options.name,
    answer: answerOf(found),
    input: isExternalTask(found.options) ? undefined : found.options.input,
  };
  if (isCodeChannelInterpreter(declaration)) return { ...base, model: undefined, instructions: "" };
  // its model through the cascade: the interpreter's own provider, its workflow's, its application's (#1313)
  const own = { model: options.model, provider: options.modelProvider, isRequired: true };
  return {
    ...base,
    ...componentModelOf(resolver, `channelInterpreters.${options.name}`, own),
    instructions: await loader.load({ label, options, source, variables: options.promptVariables }),
  };
}

/** The interpreters of a workflow's tree, model ones with their instructions loaded by `loader`. */
export async function replyInterpretersOf(
  workflow: Class,
  loader: PromptLoader,
  resolver?: ModelResolver,
): Promise<readonly AssembledReplyInterpreter[]> {
  const targets = interpretedTargetsOf(channelUsesOf([workflow]));
  return Promise.all(targets.map((target) => assembledOf(target, loader, resolver)));
}

/** The code interpreters among them: the classes the container creates. */
export const codeInterpreterClassesOf = (
  interpreters: readonly AssembledReplyInterpreter[],
): readonly Class[] =>
  interpreters.flatMap((found) => (found.model === undefined ? [found.interpreter] : []));
