import type { ApplicationOptions } from "../application/application.js";
import { OutboundCalls } from "../app/outbound-calls.js";
import { questionRoleOf } from "../channels/discovery.js";
import type { Class, Token } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import { flowClassesOf, withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { isThisWorkflow } from "../flow/this-workflow.js";
import { violation, type RuleCode, type RuleViolation } from "../graph/rule-error.js";
import { FencedEffectRepository } from "../infrastructure/fenced-effect.repository.js";
import { A2AReply, type A2AExposeOptions } from "./a2a-expose.decorator.js";

/**
 * A skill that answers with a direct message (#860, `A2AReply.Message`) is stateless, checked at
 * assembly on its workflow's every node (fail closed: a node another start reaches counts too),
 * each problem once: no pause — a question step, a question role or a channel tool —
 * (`[a2a.message-skill-pause]`); no fenced effect, outbound call or A2A call in any `deps` a node or a
 * tool reaches (`[a2a.message-skill-effect]`); only `@Tool({ readOnly: true })` tools, no `@McpTool`
 * (`[a2a.message-skill-tool]`); no `compensateWith` / `committedBy` (`[a2a.message-skill-compensation]`);
 * no child workflow, no recursion (`[a2a.message-skill-child]`). Reading a `@Rag` and the message's
 * files (`A2AFiles`) is allowed. A `reply` set for no exported start is `[a2a.message-skill-unknown]`
 * (a misspelt one would answer with a task); a `defaultSkill` that is no export
 * `[a2a.default-skill-unknown]`.
 */

/** The tokens whose use changes things outside the run: a fenced effect, a call that leaves. */
const EFFECT_TOKENS: ReadonlySet<Token> = new Set<Token>([FencedEffectRepository, OutboundCalls]);

/** One problem of a direct-reply skill: its code and what is wrong. */
interface SkillProblem {
  readonly code: RuleCode;
  readonly text: string;
}

/** The declared `deps` of a class, any kind. */
function depsOf(cls: Class): readonly Token[] {
  const declared = declarationOf(cls);
  if (declared !== undefined)
    return "deps" in declared.options ? ((declared.options.deps as readonly Token[]) ?? []) : [];
  const meta = componentOf(cls)?.meta;
  return meta !== undefined && "deps" in meta ? (meta.deps as readonly Token[]) : [];
}

/** Whether a token changes things outside the run: an effect store, `OutboundCalls`, an A2A client. */
const isEffect = (token: Token): boolean =>
  EFFECT_TOKENS.has(token) ||
  (typeof token === "function" && componentOf(token as Class)?.kind === "a2a-agent");

/** The first effect `cls`'s `deps` reach, through the classes it injects; `undefined` for none. */
function effectOf(cls: Class, seen = new Set<Token>()): Token | undefined {
  for (const token of depsOf(cls)) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (isEffect(token)) return token;
    const deeper = typeof token === "function" ? effectOf(token as Class, seen) : undefined;
    if (deeper !== undefined) return deeper;
  }
  return undefined;
}

const nameOfToken = (token: Token): string =>
  typeof token === "function" ? token.name : String((token as { description?: string }).description ?? token);

/** The problems of one tool of an agent. */
function toolProblems(agent: string, tool: Class): SkillProblem[] {
  if (questionRoleOf(tool) !== undefined)
    return [{ code: "a2a.message-skill-pause", text: `${agent} asks ${tool.name} (a question role)` }];
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

/** The problems of one node of the skill's workflow. */
function nodeProblems(node: Class): SkillProblem[] {
  const declared = declarationOf(node);
  const name = declared?.options.name ?? node.name;
  const found: SkillProblem[] = [];
  if (isThisWorkflow(node) || declared?.kind === NodeKind.Workflow)
    found.push({ code: "a2a.message-skill-child", text: `it launches ${name}` });
  if (declared?.kind === NodeKind.Question)
    found.push({ code: "a2a.message-skill-pause", text: `${name} asks its caller` });
  if (declared?.kind === NodeKind.Action) {
    const { compensateWith, committedBy } = declared.options;
    if (compensateWith !== undefined || committedBy !== undefined)
      found.push({ code: "a2a.message-skill-compensation", text: `${name} declares its undo` });
  }
  const tools = declared?.kind === NodeKind.Agent ? (declared.options.tools ?? []) : [];
  for (const tool of tools) found.push(...toolProblems(name, tool));
  for (const cls of [node, ...tools]) {
    const effect = effectOf(cls);
    if (effect !== undefined)
      found.push({
        code: "a2a.message-skill-effect",
        text: `${cls.name} injects ${nameOfToken(effect)}, which changes things outside the run`,
      });
  }
  return found;
}

/** The workflow of the application whose flow starts at `start`. */
const workflowOf = (workflows: readonly Class[], start: Class): Class | undefined =>
  withChildWorkflows(workflows).find((workflow) => {
    const declared = declarationOf(workflow);
    return declared?.kind === NodeKind.Workflow && flowClassesOf(declared.options.flow).includes(start);
  });

/** The problems of one direct-reply skill: its workflow's nodes, each problem once. */
function skillProblems(workflow: Class): SkillProblem[] {
  const declared = declarationOf(workflow);
  if (declared?.kind !== NodeKind.Workflow) return [];
  const problems = [...new Set(flowClassesOf(declared.options.flow))].flatMap(nodeProblems);
  const seen = new Set<string>();
  return problems.filter(({ code, text }) => !seen.has(`${code} ${text}`) && seen.add(`${code} ${text}`));
}

/** The exports of an `@A2AExpose` that answer with a direct message (#860). */
export const messageSkillsOf = (expose: A2AExposeOptions): readonly Class[] =>
  expose.exports.filter((start) => {
    const name = declarationOf(start)?.options.name;
    return name !== undefined && expose.skills?.[name]?.reply === A2AReply.Message;
  });

/** What an `@A2AExpose`'s own options get wrong: a reply for no export, a default of none. */
function optionProblems(expose: A2AExposeOptions, where: string): RuleViolation[] {
  const names = new Set(expose.exports.map((start) => declarationOf(start)?.options.name));
  const found = Object.entries(expose.skills ?? {})
    .filter(([name, skill]) => skill.reply !== undefined && !names.has(name))
    .map(([name]) =>
      violation(
        "a2a.message-skill-unknown",
        `${expose.name} sets the reply of ${name}, which it does not export — name an exported start`,
        [where],
      ),
    );
  const fallback = expose.defaultSkill;
  if (fallback !== undefined && !expose.exports.includes(fallback))
    found.push(
      violation(
        "a2a.default-skill-unknown",
        `${expose.name}'s defaultSkill ${fallback.name} is not one of its exports`,
        [where],
      ),
    );
  return found;
}

/** `[a2a.message-skill-*]` and `[a2a.default-skill-unknown]` of an application. */
export function messageSkillViolations(options: ApplicationOptions): RuleViolation[] {
  const where = options.name;
  // Stryker disable next-line ArrayDeclaration: no exposes, no skills either way
  return (options.exposes ?? []).flatMap((cls) => {
    const meta = componentOf(cls);
    if (meta?.kind !== "a2a-expose") return [];
    const expose = meta.meta;
    const skills = messageSkillsOf(expose).flatMap((start) => {
      const workflow = workflowOf(options.workflows, start);
      const skill = declarationOf(start)?.options.name ?? start.name;
      return (workflow === undefined ? [] : skillProblems(workflow)).map(({ code, text }) =>
        violation(
          code,
          `${skill} answers with a direct message (A2AReply.Message) and must be stateless, but ${text} — answer with a task (A2AReply.Task) or drop it`,
          [where],
        ),
      );
    });
    return [...optionProblems(expose, where), ...skills];
  });
}
