import type { ApplicationOptions } from "../application/application.js";
import { OutboundCalls } from "../app/outbound-calls.js";
import { FencedEffects } from "../app/fenced-effects.js";
import { channelRoleOptionsOf, isQuestionRole } from "../channels/channel-role.decorator.js";
import type { Class, Token } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import { flowClassesOf, withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { isThisWorkflow } from "../flow/this-workflow.js";
import { violation, type RuleCode, type RuleViolation } from "../graph/rule-error.js";
import { FencedEffectRepository } from "../infrastructure/fenced-effect.repository.js";
import type { A2AExposeOptions } from "./a2a-expose.decorator.js";
import { cardFileFieldsViolations } from "./a2a-card-file-fields.js";

/**
 * A skill that answers with a direct message (#860, `A2AReply.Message`) is stateless, checked at
 * assembly on its workflow's every node (fail closed: a node another start reaches counts too),
 * each problem once: no pause — a question step, a question role or a channel tool —
 * (`[a2a.message-skill-pause]`); no fenced effect (`FencedEffects`, `FencedEffectRepository`), outbound call or A2A call in any `deps` a node or a
 * tool reaches (`[a2a.message-skill-effect]`); only `@Tool({ readOnly: true })` tools, no `@McpTool`
 * (`[a2a.message-skill-tool]`); no `compensateWith` / `committedBy` (`[a2a.message-skill-compensation]`);
 * no child workflow, no recursion (`[a2a.message-skill-child]`). Reading a `@Rag` and the message's
 * files (`A2AFiles`) is allowed. A `reply` set for no exported start is `[a2a.unknown-skill-option]`
 * (a misspelt one would answer with a task); a `defaultSkill` that is no export
 * `[a2a.unknown-skill-option]` too.
 */

/**
 * How a skill answers a message (#860): a durable task (the default) or a direct, stateless message —
 * no task, the reply kept only to answer a resend of its `messageId` (`retention.a2aMessages`).
 */
export enum A2AReply {
  /** One A2A task, one root execution: it may pause, it outlives its connection. */
  Task = "task",
  /**
   * A direct `Message`: the skill's workflow is stateless — no pause, no fenced effect, no outbound
   * call, no undo, no child, only `readOnly` tools (`[a2a.message-skill-*]`) — and its reply is kept
   * in the `A2ADirectMessageRepository` for a resend.
   */
  Message = "message",
}

/** The tokens whose use changes things outside the run: a fenced effect, a call that leaves. */
const EFFECT_TOKENS: ReadonlySet<Token> = new Set<Token>([
  FencedEffects,
  FencedEffectRepository,
  OutboundCalls,
]);

/** One problem of a direct-reply skill: its code and what is wrong. */
interface SkillProblem {
  readonly code: RuleCode;
  readonly text: string;
}

/** The declared `deps` of a token, any kind (a node's options, a component's meta); none for others. */
function depsOf(token: Token): readonly Token[] {
  const declared = declarationOf(token)?.options ?? componentOf(token)?.meta;
  const deps: unknown = declared !== undefined && "deps" in declared ? declared.deps : undefined;
  // a decorator records `deps` as the tokens it was given
  // Stryker disable next-line ArrayDeclaration: a text in place of no deps is a token of nothing
  return Array.isArray(deps) ? (deps as readonly Token[]) : [];
}

/**
 * Whether a token changes things outside the run: an effect store, `OutboundCalls`, an A2A client —
 * each a class.
 */
const isEffect = (token: Token): token is Class =>
  EFFECT_TOKENS.has(token) || componentOf(token)?.kind === "a2a-agent";

/** The first effect `token`'s `deps` reach, through the tokens it injects; `undefined` for none. */
function effectOf(token: Token, seen = new Set<Token>()): Class | undefined {
  for (const dep of depsOf(token)) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    if (isEffect(dep)) return dep;
    const deeper = effectOf(dep, seen);
    if (deeper !== undefined) return deeper;
  }
  return undefined;
}

/** The problems of one tool of an agent. */
function toolProblems(agent: string, tool: Class): SkillProblem[] {
  const role = channelRoleOptionsOf(tool);
  if (role !== undefined && isQuestionRole(role))
    return [
      { code: "a2a.message-skill-pause", text: `${agent} asks ${tool.name} (a question role)` },
    ];
  const component = componentOf(tool);
  if (component?.kind === "mcp-tool")
    return [{ code: "a2a.message-skill-tool", text: `${agent} calls ${tool.name}, an @McpTool` }];
  if (component?.kind !== "tool") return [];
  const found: SkillProblem[] = [];
  if (component.meta.channel !== undefined)
    found.push({ code: "a2a.message-skill-pause", text: `${tool.name} asks for approval` });
  if (component.meta.readOnly !== true)
    found.push({
      code: "a2a.message-skill-tool",
      text: `${agent} calls ${tool.name}, which is not @Tool({ readOnly: true })`,
    });
  return found;
}

/** What a node is, by its kind: a child, a question, an undo; none for any other. */
function kindProblem(node: Class, name: string): SkillProblem | undefined {
  const declared = declarationOf(node);
  if (isThisWorkflow(node) || declared?.kind === NodeKind.Workflow)
    return { code: "a2a.message-skill-child", text: `it launches ${name}` };
  if (declared?.kind === NodeKind.Question)
    return { code: "a2a.message-skill-pause", text: `${name} asks its caller` };
  if (declared?.kind !== NodeKind.Action) return undefined;
  const { compensateWith, committedBy } = declared.options;
  return compensateWith === undefined && committedBy === undefined
    ? undefined
    : { code: "a2a.message-skill-compensation", text: `${name} declares its undo` };
}

/** The effect a class's services reach, as a problem; none for none. */
function effectProblem(cls: Class): SkillProblem | undefined {
  const effect = effectOf(cls);
  return effect === undefined
    ? undefined
    : {
        code: "a2a.message-skill-effect",
        text: `${cls.name} injects ${effect.name}, which changes things outside the run`,
      };
}

/** The problems of one node of the skill's workflow. */
function nodeProblems(node: Class): SkillProblem[] {
  const declared = declarationOf(node);
  const name = declared?.options.name ?? node.name;
  // Stryker disable next-line ArrayDeclaration: a text in place of no tools is no tool, no problem
  const tools = declared?.kind === NodeKind.Agent ? (declared.options.tools ?? []) : [];
  return [
    ...[kindProblem(node, name)].flatMap((problem) => problem ?? []),
    ...tools.flatMap((tool) => toolProblems(name, tool)),
    ...[node, ...tools].flatMap((cls) => effectProblem(cls) ?? []),
  ];
}

/** The nodes of the application's workflow whose flow starts at `start`; `undefined` for none. */
function flowOf(workflows: readonly Class[], start: Class): readonly Class[] | undefined {
  for (const workflow of withChildWorkflows(workflows)) {
    const declared = declarationOf(workflow);
    if (declared?.kind !== NodeKind.Workflow) continue;
    const nodes = flowClassesOf(declared.options.flow);
    if (nodes.includes(start)) return nodes;
  }
  return undefined;
}

/** The problems of one direct-reply skill: its workflow's nodes (none: no workflow), each once. */
function skillProblems(nodes: readonly Class[] | undefined): SkillProblem[] {
  const problems = [...new Set(nodes)].flatMap(nodeProblems);
  const seen = new Set<string>();
  return problems.filter(
    ({ code, text }) => !seen.has(`${code} ${text}`) && seen.add(`${code} ${text}`),
  );
}

/** The exports of an `@A2AExpose` that answer with a direct message, each with its skill's name. */
function messageSkillEntriesOf(expose: A2AExposeOptions): (readonly [string, Class])[] {
  return expose.exports.flatMap((start) => {
    const name = declarationOf(start)?.options.name;
    const isMessage = name !== undefined && expose.skills?.[name]?.reply === A2AReply.Message;
    return isMessage ? [[name, start] as const] : [];
  });
}

/** The exports of an `@A2AExpose` that answer with a direct message (#860). */
export const messageSkillsOf = (expose: A2AExposeOptions): readonly Class[] =>
  messageSkillEntriesOf(expose).map(([, start]) => start);

/** What an `@A2AExpose`'s own options get wrong: a reply for no export, a default of none. */
function optionProblems(expose: A2AExposeOptions, where: string): RuleViolation[] {
  const names = new Set(expose.exports.map((start) => declarationOf(start)?.options.name));
  const found = Object.entries(expose.skills ?? {})
    .filter(([name, skill]) => skill.reply !== undefined && !names.has(name))
    .map(([name]) =>
      violation(
        "a2a.unknown-skill-option",
        `${expose.name} sets the reply of ${name}, which it does not export — name an exported start`,
        [where],
      ),
    );
  const fallback = expose.defaultSkill;
  if (fallback !== undefined && !expose.exports.includes(fallback))
    found.push(
      violation(
        "a2a.unknown-skill-option",
        `${expose.name}'s defaultSkill ${fallback.name} is not one of its exports`,
        [where],
      ),
    );
  return found;
}

/**
 * `[a2a.message-skill-*]`, `[a2a.unknown-skill-option]` and (#904) `[a2a.card-file-fields-invalid]`
 * of an application.
 */
export function messageSkillViolations(options: ApplicationOptions): RuleViolation[] {
  const where = options.name;
  // Stryker disable next-line ArrayDeclaration: no exposes, no skills either way
  return (options.exposes ?? []).flatMap((cls) => {
    const meta = componentOf(cls);
    if (meta?.kind !== "a2a-expose") return [];
    const expose = meta.meta;
    const skills = messageSkillEntriesOf(expose).flatMap(([skill, start]) => {
      const nodes = flowOf(options.workflows, start);
      return skillProblems(nodes).map(({ code, text }) =>
        violation(
          code,
          `${skill} answers with a direct message (A2AReply.Message) and must be stateless, but ${text} — answer with a task (A2AReply.Task) or drop it`,
          [where],
        ),
      );
    });
    const exported = new Set(
      expose.exports.map((start) => declarationOf(start)?.options.name ?? ""),
    );
    return [
      ...optionProblems(expose, where),
      ...cardFileFieldsViolations(expose.name, expose, exported, where),
      ...skills,
    ];
  });
}
