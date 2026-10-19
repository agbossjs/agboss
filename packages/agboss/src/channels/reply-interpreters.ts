import type { Class } from "../components/injection.js";
import type { PromptLoader } from "../components/prompt-render.js";
import { ToolCallApprovalDecisionDto } from "../dto/standard/framework.js";
import type { DtoClass } from "../dto/types.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { isDecisionModel } from "../models/decision-models.js";
import { kindSuffixProblem, NameKind } from "../flow/names.js";
import type { FoundChannelRole } from "./channel-role.decorator.js";
import { channelUsesOf, rolesOf, type ChannelUse } from "./discovery.js";
import {
  isCodeReplyInterpreter,
  replyInterpreterOf,
  type ReplyInterpreterDeclaration,
} from "./reply-interpreter.js";

/**
 * The reply interpreters of a workflow's tree (#267 PR 3): the `replyInterpreter` of every channel
 * role its tools — its children's too — name, checked at assembly (`[name.kind-suffix]`,
 * `[reply-interpreter.not-an-interpreter]`, `[reply-interpreter.decision-model]`,
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
  /** A model interpreter's chat model; `undefined` for a code one. */
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
function declarationViolations({ interpreter, declaration }: InterpretedRole): RuleViolation[] {
  const { options } = declaration;
  const suffix = kindSuffixProblem(options.name, NameKind.ReplyInterpreter);
  const found = suffix === undefined ? [] : [violation(suffix.code, suffix.message, [options.name])];
  if (isCodeReplyInterpreter(options)) {
    const interpret: unknown = Reflect.get(interpreter.prototype as object, "interpret");
    if (typeof interpret === "function") return found;
    const message = `${nameOf(interpreter)} (${options.name}) is decided by code but has no interpret(input) method — implements ReplyInterpreterHandler<${nameOf(interpreter)}>`;
    return [...found, violation("reply-interpreter.no-interpret-method", message, [options.name])];
  }
  if (!isDecisionModel(options.model)) return found;
  const message = `${options.name}: ${options.model} is a decision model — it cannot give a typed answer; name a chat model, or decide by code (DecidedBy.Code)`;
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
