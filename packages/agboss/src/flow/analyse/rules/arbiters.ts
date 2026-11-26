import { ComponentKind } from "../../runtime/records.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import type { Class } from "../../../components/injection.js";
import type { ArbiterClass } from "../../ast.js";
import {
  answerMethodsOf,
  arbiterOf,
  ArbiterModel,
  isCodeArbiter,
  type ArbiterDeclaration,
} from "../../decorators/arbiter.js";
import { kebabNameProblem } from "../../names.js";
import type { ComponentName } from "../../registry.js";
import type { FlowLaunch } from "../flow-graph.js";
import { launchLabel } from "../join-groups.js";
import { classLabel } from "../labels.js";
import { groupTargetNames } from "../quorum-joins.js";
import type { AnalysisContext } from "./context.js";

/**
 * The arbiter rules (#279 AC5, AC6, #1283): an `.arbitratedBy(X)` names an `@Arbiter` class
 * (`[arbiter.not-an-arbiter]`); it covers every distinct target of its launch — a criterion of a
 * declarative arbiter or an `@Arbitrate(…targets)` method of a code one, each
 * (`[arbiter.unhandled-target]`; the arbiter's `prompt` never stands in) — and nothing else
 * (`[arbiter.unknown-target]`), once (`[arbiter.duplicate-target]`); a launch an arbiter judges
 * has no void `@Action` branch (`[arbiter.branch-has-no-output]`). Its types — the answer, `boolean`,
 * one parameter — are the compiler's.
 */

/** One target an arbiter judges: by its criterion, or by the method named here. */
interface Judged {
  readonly target: Class;
  readonly method?: string;
}

const nameOf = (agent: Class): ComponentName => {
  const [name] = groupTargetNames([agent]);
  return name ?? ("" as ComponentName);
};

/** What the arbiter judges: its criteria, or its `@Arbitrate` methods' targets. */
const judgedBy = (arbiter: ArbiterClass, declaration: ArbiterDeclaration): readonly Judged[] =>
  isCodeArbiter(declaration.options)
    ? answerMethodsOf(arbiter).flatMap(({ targets, method }) =>
        targets.map((target) => ({ target, method })),
      )
    : declaration.options.criteria.map(({ target }) => ({ target }));

interface Judging {
  readonly name: string;
  readonly isCode: boolean;
  readonly launch: FlowLaunch;
  readonly judged: readonly Judged[];
}

/** How a message names what judges a target: its method, or its criterion. */
const judgement = (judging: Judging, target: string): string =>
  judging.isCode ? `@Arbitrate(${target}) method` : `criterion for ${target}`;

/** The fix of a missing judgement: a method, or an explicit criterion — never the `prompt`. */
const addOne = (judging: Judging): string =>
  judging.isCode
    ? "add the method"
    : 'add one — its prompt never stands in; a target that needs no real check gets "Any non-empty answer"';

function coverage(judging: Judging, targetClassOf: TargetClassOf): readonly RuleViolation[] {
  const { name, launch, judged } = judging;
  const label = launchLabel(launch);
  const covered = judged.map(({ target }) => nameOf(target));
  const launched = launch.branches.map((branch) => branch.node);
  const unhandled = launched
    .filter((target) => !covered.includes(target))
    .map((target) => {
      const message = `${name} has no ${judgement(judging, targetClassOf(target))} for this launch (${label}) — ${addOne(judging)}`;
      return violation("arbiter.unhandled-target", message, [name]);
    });
  const unknown = judged
    .filter(({ target }) => !launched.includes(nameOf(target)))
    .map(({ target }) => {
      const message = `${name} has a ${judgement(judging, classLabel(target))}, but ${label} does not launch ${classLabel(target)} — remove it`;
      return violation("arbiter.unknown-target", message, [name]);
    });
  return [...unhandled, ...unknown];
}

function duplicates(judging: Judging): readonly RuleViolation[] {
  const byTarget = new Map<ComponentName, Judged[]>();
  for (const one of judging.judged)
    byTarget.set(nameOf(one.target), [...(byTarget.get(nameOf(one.target)) ?? []), one]);
  return [...byTarget.values()]
    .filter((group) => group.length > 1)
    .flatMap(([first, ...rest]) => {
      if (first === undefined) return [];
      const target = classLabel(first.target);
      const methods = [first, ...rest].map((one) => one.method ?? "").join(", ");
      const message = judging.isCode
        ? `${judging.name} has ${String(rest.length + 1)} @Arbitrate(${target}) methods (${methods}) — one method per target class; share a rule through a private method`
        : `${judging.name} has ${String(rest.length + 1)} criteria for ${target} — one criterion per target class`;
      return [violation("arbiter.duplicate-target", message, [judging.name])];
    });
}

/** The class name of a launched target, for messages. */
type TargetClassOf = (target: ComponentName) => string;

/** A branch that gives no answer (a void `@Action`) leaves an arbiter nothing to judge. */
function voidBranches(
  judging: Judging,
  context: AnalysisContext,
  targetClassOf: TargetClassOf,
): readonly RuleViolation[] {
  return judging.launch.branches.flatMap(({ node }) => {
    const found = context.graph.nodes.get(node);
    const declaration = found?.declaration;
    if (declaration?.kind !== ComponentKind.Action || declaration.options.output !== undefined)
      return [];
    const message = `${judging.name} judges ${targetClassOf(node)} (${launchLabel(judging.launch)}), an @Action without an output — give it an output, or leave it out of the launch`;
    return [violation("arbiter.branch-has-no-output", message, [judging.name])];
  });
}

/**
 * A code arbiter has a model only when it injects `ArbiterModel`: `model` / `modelProvider` without it
 * would name a model nothing can call (the types forbid it; plain JS and parsed options do not).
 */
function modelWithoutArbiterModel(declaration: ArbiterDeclaration): readonly RuleViolation[] {
  const { options } = declaration;
  if (!isCodeArbiter(options) || (options.deps ?? []).includes(ArbiterModel)) return [];
  const named = [
    ...(options.model === undefined ? [] : ["model"]),
    ...(options.modelProvider === undefined ? [] : ["modelProvider"]),
  ];
  if (named.length === 0) return [];
  const message = `${options.name} names ${named.join(" and ")} but does not inject ArbiterModel — add ArbiterModel to deps (a hybrid arbiter), or drop ${named.join(" and ")} (a code arbiter has no model)`;
  return [violation("arbiter.model-without-arbiter-model", message, [options.name])];
}

function oneArbiter(
  arbiter: ArbiterClass,
  launch: FlowLaunch,
  context: AnalysisContext,
  targetClassOf: TargetClassOf,
): readonly RuleViolation[] {
  const declaration = arbiterOf(arbiter);
  if (declaration === undefined) {
    const message = `.arbitratedBy(${classLabel(arbiter)}): ${classLabel(arbiter)} has no @Arbiter decorator — decorate it with @Arbiter({ … })`;
    return [violation("arbiter.not-an-arbiter", message, [])];
  }
  const { name } = declaration.options;
  const isCode = isCodeArbiter(declaration.options);
  const judging: Judging = { name, isCode, launch, judged: judgedBy(arbiter, declaration) };
  const suffix = kebabNameProblem(name, "@Arbiter");
  return [
    ...(suffix === undefined ? [] : [violation(suffix.code, suffix.message, [name])]),
    ...modelWithoutArbiterModel(declaration),
    ...coverage(judging, targetClassOf),
    ...duplicates(judging),
    ...voidBranches(judging, context, targetClassOf),
  ];
}

/** Every arbiter of a launch, each checked against the launch's agents. */
export function arbiterViolations(
  context: AnalysisContext,
  launch: FlowLaunch,
): readonly RuleViolation[] {
  const targetClassOf: TargetClassOf = (target) => {
    const node = context.graph.nodes.get(target);
    return node === undefined ? target : classLabel(node.component);
  };
  return launch.arbitratedBy === undefined
    ? []
    : oneArbiter(launch.arbitratedBy, launch, context, targetClassOf);
}
