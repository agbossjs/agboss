import type { Class } from "../../components/injection.js";
import { cascadeDefaults } from "../../config/defaults.js";
import { GraphRuleError, violation, type RuleViolation } from "../../graph/rule-error.js";
import { NodeKind } from "../ast.js";
import { declarationOf } from "../decorators/declaration.js";
import type { ComponentName } from "../registry.js";
import { childEntriesOf, chooseStarts, type ChildChoice } from "./children.js";
import { runDataflow, statesOf, type Dataflow } from "./dataflow.js";
import { resolveFields, type ResolvedField } from "./fields.js";
import type { FlowGraph } from "./flow-graph.js";
import { classLabel } from "./labels.js";
import { projectInput, type InputShape } from "./projection.js";
import { recursionOf, type Recursion } from "./recursion.js";
import { aboutRules } from "./rules/about.js";
import { branchOutdatingRules } from "./rules/branch-outdating.js";
import { childFailureWarnings } from "./rules/child-failure.js";
import { childRules } from "./rules/children.js";
import type { AnalyseOptions, AnalysisContext, FlowRule } from "./rules/context.js";
import { cycleRules } from "./rules/cycles.js";
import { dataInputRules } from "./rules/data-inputs.js";
import { dataOutputRules } from "./rules/data-outputs.js";
import { depthRules } from "./rules/depth.js";
import { errorRules } from "./rules/errors.js";
import { graphRules } from "./rules/graph.js";
import { guardrailRules } from "./rules/guardrails.js";
import { launchRules } from "./rules/launches.js";
import { limitHandlerRules } from "./rules/limit-handlers.js";
import { modelRules } from "./rules/models.js";
import { nameRules } from "./rules/names.js";
import { optionsRules } from "./rules/options.js";
import { outdatedRules } from "./rules/outdated.js";
import { placementRules } from "./rules/placement.js";
import { quorumRules } from "./rules/quorum.js";
import { returnsRules } from "./rules/returns.js";
import { concurrencyErrors, concurrencyWarnings, recursionRules } from "./rules/recursion.js";
import { routerRules } from "./rules/routers.js";
import { switchRules } from "./rules/switch.js";
import { textAgentRules } from "./rules/text-agents.js";
import { stepsRules } from "./steps.js";
import { walkFlow } from "./walk.js";
import { worstCasesOf, type WorstCase } from "./worst-case.js";

/**
 * The static analyser of a v2 workflow (#272 PR 2, #270, #271): walks the flow's paths into a graph,
 * runs the data-flow engine (with outdating) to a fixed point, and checks every rule — all violations at once, before any
 * model call, in one `GraphRuleError`. Warnings (`[flow.path-too-deep]`,
 * `[graph.child-without-failure-finish]`) are errors under `strict`.
 * Its result is what type generation (PR 3) and the runtime (PR 4) read.
 */

export interface FlowAnalysis {
  readonly workflow: string;
  readonly graph: FlowGraph;
  readonly fields: ReadonlyMap<ComponentName, readonly ResolvedField[]>;
  readonly dataflow: Dataflow;
  readonly warnings: readonly RuleViolation[];
  /** Every edge into a child workflow and the start it enters through (#263). */
  readonly children: readonly ChildChoice[];
  /** The worst case of one call of each start (#261, #273). */
  readonly worstCases: readonly WorstCase[];
  /** How it launches itself (`ThisWorkflow`, #264); absent when it does not. */
  readonly recursion?: Recursion;
}

/** Every finding of one workflow: its analysis (when it is a workflow), errors and warnings. */
export interface FlowCheck {
  readonly analysis?: FlowAnalysis;
  readonly errors: readonly RuleViolation[];
  readonly warnings: readonly RuleViolation[];
}

const RULES: readonly FlowRule[] = [
  nameRules,
  graphRules,
  placementRules,
  cycleRules,
  switchRules,
  textAgentRules,
  errorRules,
  returnsRules,
  routerRules,
  guardrailRules,
  modelRules,
  optionsRules,
  dataInputRules,
  dataOutputRules,
  outdatedRules,
  aboutRules,
  stepsRules,
  launchRules,
  quorumRules,
  branchOutdatingRules,
  childRules,
  limitHandlerRules,
];

/** Every message names the workflow first. */
const naming =
  (workflow: string) =>
  (found: RuleViolation): RuleViolation =>
    found.message.startsWith(`${workflow}:`) || found.message.startsWith(`${workflow} `)
      ? found
      : violation(found.code, `${workflow}: ${found.message}`, found.nodes);

const canonical = (found: readonly RuleViolation[]): readonly RuleViolation[] =>
  [...found].sort((first, second) =>
    first.code === second.code
      ? first.message.localeCompare(second.message)
      : first.code.localeCompare(second.code),
  );

/** Checks a workflow without throwing. */
export function checkWorkflow(workflow: Class, options: AnalyseOptions = {}): FlowCheck {
  const declaration = declarationOf(workflow);
  if (declaration?.kind !== NodeKind.Workflow) {
    const message = `${classLabel(workflow)} has no @Workflow decorator — decorate it with @Workflow({ name, version, flow })`;
    return { errors: [violation("graph.not-a-node", message, [])], warnings: [] };
  }
  const walked = walkFlow(declaration.options.flow, workflow);
  const entries = childEntriesOf(walked.graph);
  const fields = resolveFields(walked.graph, entries);
  const dataflow = runDataflow(walked.graph, fields);
  const children = chooseStarts(entries, dataflow);
  const defaults = cascadeDefaults(options.applicationDefaults, declaration.options.defaults);
  const context: AnalysisContext = {
    workflow: defaults === undefined ? declaration.options : { ...declaration.options, defaults },
    walked,
    graph: walked.graph,
    fields,
    dataflow,
    children,
    options,
  };
  const named = naming(declaration.options.name);
  const recursion = recursionOf(walked.graph, declaration.options.maxDepth);
  const errors = [
    ...walked.violations,
    ...RULES.flatMap((rule) => rule(context)),
    ...recursionRules(context, workflow, recursion),
    ...concurrencyErrors(context),
  ].map(named);
  const warnings = [
    ...depthRules(context),
    ...childFailureWarnings(context),
    ...concurrencyWarnings(context),
  ].map(named);
  const analysis: FlowAnalysis = {
    workflow: declaration.options.name,
    graph: walked.graph,
    fields,
    dataflow,
    warnings,
    children,
    worstCases: worstCasesOf(walked.graph, declaration.options, workflow),
    ...(recursion === undefined ? {} : { recursion }),
  };
  return options.strict === true
    ? { analysis, errors: canonical([...errors, ...warnings]), warnings: [] }
    : { analysis, errors: canonical(errors), warnings: canonical(warnings) };
}

/** Analyses a workflow; throws one `GraphRuleError` with every violation found. */
export function analyseWorkflow(workflow: Class, options: AnalyseOptions = {}): FlowAnalysis {
  const { analysis, errors } = checkWorkflow(workflow, options);
  if (errors.length > 0 || analysis === undefined) throw new GraphRuleError(errors);
  return analysis;
}

/** The distinct shapes of a node's input over its reachable scopes (S4; type generation reads them). */
export function inputShapesOf(analysis: FlowAnalysis, node: string): readonly InputShape[] {
  const name = node as ComponentName;
  const scopes = statesOf(analysis.dataflow, name).map((state) => state.scope);
  return projectInput(scopes, analysis.fields.get(name) ?? []);
}
