import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import type { ArbiterClass, ComponentClass } from "../../ast.js";
import {
  answerMethodsOf,
  arbiterOf,
  isCodeArbiter,
  type ArbiterDeclaration,
} from "../../decorators/arbiter.js";
import { kindSuffixProblem, NameKind } from "../../names.js";
import type { ComponentName } from "../../registry.js";
import type { FlowLaunch } from "../flow-graph.js";
import { launchLabel } from "../join-groups.js";
import { classLabel } from "../labels.js";
import { groupAgentNames } from "../quorum-joins.js";
import type { AnalysisContext } from "./context.js";

/**
 * The arbiter rules (#279 AC5, AC6): an `.acceptedBy(X)` names an `@Arbiter` class
 * (`[arbiter.not-an-arbiter]`) whose `name` ends with `-arbiter`; it covers every distinct agent
 * class of its launch — a criterion (`DecidedBy.Model`) or an `@OnAnswer(Agent)` method
 * (`DecidedBy.Code`) each (`[arbiter.unhandled-agent]`; the arbiter's `prompt` never stands in) —
 * and nothing else (`[arbiter.unknown-agent]`), once (`[arbiter.duplicate-agent]`); a model arbiter
 * has no `@OnAnswer` methods (`[arbiter.answer-method-on-model]`); a code arbiter's method judging
 * `CompanyCheckAgent` is named `fromCompanyCheck` (`[arbiter.method-name]`). Its types — the answer,
 * `boolean`, one parameter — are the compiler's.
 */

/** One agent an arbiter judges: by its criterion, or by the method named here. */
interface Judged {
  readonly agent: ComponentClass;
  readonly method?: string;
}

const nameOf = (agent: ComponentClass): ComponentName => {
  const [name] = groupAgentNames([agent]);
  return name ?? ("" as ComponentName);
};

/** What the arbiter judges: its criteria, or its `@OnAnswer` methods. */
const judgedBy = (arbiter: ArbiterClass, declaration: ArbiterDeclaration): readonly Judged[] =>
  isCodeArbiter(declaration.options)
    ? answerMethodsOf(arbiter).map(({ agent, method }) => ({ agent, method }))
    : declaration.options.criteria.map(({ agent }) => ({ agent }));

/** `fromCompanyCheck` for `CompanyCheckAgent`: `from` and the class name without `Agent`. */
const methodNameFor = (agent: ComponentClass): string =>
  `from${classLabel(agent).replace(/Agent$/, "")}`;

interface Judging {
  readonly name: string;
  readonly isCode: boolean;
  readonly launch: FlowLaunch;
  readonly judged: readonly Judged[];
}

/** How a message names what judges an agent: its method, or its criterion. */
const judgement = (judging: Judging, agent: string): string =>
  judging.isCode ? `@OnAnswer(${agent}) method` : `criterion for ${agent}`;

/** The fix of a missing judgement: a method, or an explicit criterion — never the `prompt`. */
const addOne = (judging: Judging): string =>
  judging.isCode
    ? "add the method"
    : 'add one — its prompt never stands in; an agent that needs no real check gets "Any non-empty answer"';

function coverage(judging: Judging, agentClassOf: AgentClassOf): readonly RuleViolation[] {
  const { name, launch, judged } = judging;
  const label = launchLabel(launch);
  const covered = judged.map(({ agent }) => nameOf(agent));
  const launched = launch.branches.map((branch) => branch.node);
  const unhandled = launched
    .filter((agent) => !covered.includes(agent))
    .map((agent) => {
      const message = `${name} has no ${judgement(judging, agentClassOf(agent))} for this launch (${label}) — ${addOne(judging)}`;
      return violation("arbiter.unhandled-agent", message, [name]);
    });
  const unknown = judged
    .filter(({ agent }) => !launched.includes(nameOf(agent)))
    .map(({ agent }) => {
      const message = `${name} has a ${judgement(judging, classLabel(agent))}, but ${label} does not launch ${classLabel(agent)} — remove it`;
      return violation("arbiter.unknown-agent", message, [name]);
    });
  return [...unhandled, ...unknown];
}

function duplicates(judging: Judging): readonly RuleViolation[] {
  const byAgent = new Map<ComponentName, Judged[]>();
  for (const one of judging.judged)
    byAgent.set(nameOf(one.agent), [...(byAgent.get(nameOf(one.agent)) ?? []), one]);
  return [...byAgent.values()]
    .filter((group) => group.length > 1)
    .flatMap(([first, ...rest]) => {
      if (first === undefined) return [];
      const agent = classLabel(first.agent);
      const methods = [first, ...rest].map((one) => one.method ?? "").join(", ");
      const message = judging.isCode
        ? `${judging.name} has ${String(rest.length + 1)} @OnAnswer(${agent}) methods (${methods}) — one method per agent class; share a rule through a private method`
        : `${judging.name} has ${String(rest.length + 1)} criteria for ${agent} — one criterion per agent class`;
      return [violation("arbiter.duplicate-agent", message, [judging.name])];
    });
}

function methodNames(judging: Judging): readonly RuleViolation[] {
  return judging.judged.flatMap(({ agent, method }) => {
    const expected = methodNameFor(agent);
    if (method === undefined || method === expected) return [];
    const message = `${judging.name}.${method}: the @OnAnswer(${classLabel(agent)}) method is named ${expected} — rename it`;
    return [violation("arbiter.method-name", message, [judging.name])];
  });
}

/** The class name of a launched agent, for messages. */
type AgentClassOf = (agent: ComponentName) => string;

function oneArbiter(
  arbiter: ArbiterClass,
  launch: FlowLaunch,
  agentClassOf: AgentClassOf,
): readonly RuleViolation[] {
  const declaration = arbiterOf(arbiter);
  if (declaration === undefined) {
    const message = `.acceptedBy(${classLabel(arbiter)}): ${classLabel(arbiter)} has no @Arbiter decorator — decorate it with @Arbiter({ name, decidedBy, … })`;
    return [violation("arbiter.not-an-arbiter", message, [])];
  }
  const { name } = declaration.options;
  const isCode = isCodeArbiter(declaration.options);
  const judging: Judging = { name, isCode, launch, judged: judgedBy(arbiter, declaration) };
  const suffix = kindSuffixProblem(name, NameKind.Arbiter);
  const methods = answerMethodsOf(arbiter);
  const misplaced =
    isCode || methods.length === 0
      ? []
      : [
          violation(
            "arbiter.answer-method-on-model",
            `${name} is decided by its model (DecidedBy.Model) — remove @OnAnswer from ${methods.map((one) => one.method).join(", ")}, or make it DecidedBy.Code`,
            [name],
          ),
        ];
  return [
    ...(suffix === undefined ? [] : [violation(suffix.code, suffix.message, [name])]),
    ...misplaced,
    ...coverage(judging, agentClassOf),
    ...duplicates(judging),
    ...(isCode ? methodNames(judging) : []),
  ];
}

/** Every arbiter of a launch, each checked against the launch's agents. */
export function arbiterViolations(
  context: AnalysisContext,
  launch: FlowLaunch,
): readonly RuleViolation[] {
  const agentClassOf: AgentClassOf = (agent) => {
    const node = context.graph.nodes.get(agent);
    return node === undefined ? agent : classLabel(node.component);
  };
  return (launch.acceptedBy ?? []).flatMap(({ arbiters }) =>
    arbiters.flatMap((arbiter) => oneArbiter(arbiter, launch, agentClassOf)),
  );
}
