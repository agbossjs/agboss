import type { AgentSettingsOf, AgentsConfigOf } from "../config/types.js";
import { AnswerFiles } from "../files/model-files.js";
import { NodeKind } from "../flow/ast.js";
import { DecidedBy } from "../flow/decorators/router.js";
import { answerToolsOf, NO_ANSWER_TOOLS, type AnswerTools } from "../flow/runtime/answer-tools.js";
import { resolveAgentLimits, type AgentDefinition, type AgentJudge } from "./agent-loop/index.js";
import type { GraphDeps } from "./deps.js";
import { defaultMaxResultSizeOf } from "../tools/index.js";

export class MissingAgentPromptError extends Error {
  override name = "MissingAgentPromptError";
}

/** A wiring bug: an agent names a judge the app did not create. */
export class MissingJudgeError extends Error {
  override name = "MissingJudgeError";
}

/** An agent's limits with defaults applied. */
const limitsOf = <TName extends string>(
  agent: AgentSettingsOf<string> | undefined,
  config: AgentsConfigOf<TName>,
): Pick<AgentDefinition, "limits" | "maxResultSize" | "files"> => ({
  ...(agent?.files === undefined ? {} : { files: agent.files }),
  limits: resolveAgentLimits(agent?.maxToolCalls, config.defaults.tools?.maxToolCalls).limits,
  maxResultSize: defaultMaxResultSizeOf(config.defaults.tools?.maxResultSize),
});

/** An agent's judges (`agents.<name>.judges`): each one's instance and its own model (none for a code judge). */
function judgesOf<TName extends string>(
  agent: AgentSettingsOf<string> | undefined,
  deps: GraphDeps<TName>,
): Pick<AgentDefinition, "judges" | "maxRetries"> {
  const judges = (agent?.judges ?? []).map((name): AgentJudge => {
    const judge = deps.judges?.get(name);
    if (judge === undefined) throw new MissingJudgeError(`Judge "${name}" has no instance`);
    const { handler, reply } = judge;
    // a code judge (#396) has no model; a model judge always has its binding
    if (judge.decidedBy === DecidedBy.Code) return { name, handler, reply };
    const binding = deps.registry.judges.get(name);
    if (binding === undefined) throw new MissingJudgeError(`Judge "${name}" has no model`);
    return { name, handler, reply, binding };
  });
  return { judges, maxRetries: agent?.maxRetries ?? 0 };
}

/** How an agent of the graph answers: its `output`'s answer tools, none for a text agent. */
function answerToolsFor<TName extends string>(
  deps: GraphDeps<TName>,
  name: string,
  files: AgentSettingsOf<string>["files"],
): AnswerTools {
  const declaration = deps.graph.nodes.get(name)?.declaration;
  // the files of its answer are picked by number from the ones it saw (#899 §8), unless the developer allowed any
  const isPicking = files?.answerFiles === AnswerFiles.SeenInVisit;
  return declaration?.kind === NodeKind.Agent
    ? answerToolsOf(declaration.options.output, isPicking)
    : NO_ANSWER_TOOLS;
}

/** Every configured agent with its model, prompt, tools, limits, knowledge and judges. */
export function agentDefinitions<TName extends string>(
  deps: GraphDeps<TName>,
): ReadonlyMap<string, AgentDefinition> {
  const prompts = new Map<string, string>(Object.entries(deps.prompts));
  const settings = new Map<string, AgentSettingsOf<string>>(Object.entries(deps.config.agents));
  const definitions = new Map<string, AgentDefinition>();
  for (const [name, binding] of deps.registry.agents) {
    const instructions = prompts.get(name);
    if (instructions === undefined) throw new MissingAgentPromptError(`No prompt for ${name}`);
    const agent = settings.get(name);
    const memory = deps.memory?.get(name);
    definitions.set(name, {
      name,
      binding,
      instructions,
      tools: (agent?.tools ?? []).map(deps.tools),
      answerTools: answerToolsFor(deps, name, agent?.files),
      ...limitsOf(agent, deps.config),
      ...judgesOf(agent, deps),
      knowledge: deps.knowledge?.(name) ?? [],
      ...(memory === undefined ? {} : { memory }),
    });
  }
  return definitions;
}
