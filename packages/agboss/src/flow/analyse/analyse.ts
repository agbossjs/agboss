import { ConfigError } from "../../core/error-families/config-errors.js";
import type { Class } from "../../components/injection.js";
import { cascadeDefaults } from "../../config/defaults.js";
import { violation, type RuleViolation } from "../../graph/rule-error.js";
import { NodeKind } from "../ast.js";
import { declarationOf } from "../decorators/declaration.js";
import {
  declaredExecutionLimitsOf,
  type WorkflowDefaults,
  type WorkflowExecutionLimits,
  type WorkflowOptions,
} from "../decorators/workflow.js";
import type { ComponentName } from "../registry.js";
import { childEntriesOf, chooseStarts, type ChildChoice } from "./children.js";
import { runDataflow, statesOf, type Dataflow } from "./dataflow.js";
import { resolveFields, type ResolvedField } from "./fields.js";
import type { FlowGraph } from "./flow-graph.js";
import { classLabel } from "./labels.js";
import { projectInput, type InputShape } from "./projection.js";
import { recursionOf, type Recursion } from "./recursion.js";
import { branchOutdatingRules } from "./rules/branch-outdating.js";
import { childFailureWarnings } from "./rules/child-failure.js";
import { remindBeforeWarnings } from "./remind-before.js";
import { judgeFamilyWarnings, judgeRetryWarnings } from "./rules/judge-family.js";
import { childRules } from "./rules/children.js";
import { compensationRules, compensationWarnings } from "./rules/compensation.js";
import type { AnalyseOptions, AnalysisContext, FlowRule } from "./rules/context.js";
import { cycleRules } from "./rules/cycles.js";
import { dataInputRules } from "./rules/data-inputs.js";
import { dataOutputRules } from "./rules/data-outputs.js";
import { depthRules } from "./rules/depth.js";
import { errorRules } from "./rules/errors.js";
import { graphRules } from "./rules/graph.js";
import { launchRules } from "./rules/launches.js";
import { limitHandlerRules } from "./rules/limit-handlers.js";
import { dtoCycleRules } from "./rules/dto-cycles.js";
import { dtoOneOfRules } from "./rules/dto-one-of.js";
import { modelRules } from "./rules/models.js";
import { nameRules } from "./rules/names.js";
import { countLimitRules, optionsRules } from "./rules/options.js";
import { historyTtlRules } from "./rules/history-ttl.js";
import { outdatedRules } from "./rules/outdated.js";
import { placementRules } from "./rules/placement.js";
import { quorumRules } from "./rules/quorum.js";
import { concurrencyErrors, concurrencyWarnings, recursionRules } from "./rules/recursion.js";
import { routerRules } from "./rules/routers.js";
import { oneOfRules } from "./rules/one-of.js";
import { judgeOutputRules, textAgentRules } from "./rules/text-agents.js";
import { stepsRules } from "./steps.js";
import { stepsAboveOldDefaultWarnings } from "./steps-default.js";
import { worstCaseStepsWarnings } from "./strongly-connected.js";
import { walkFlow } from "./walk.js";
import { graphClassesOf, unknownOptionViolations } from "../../application/unknown-option-rules.js";
import { worstCasesOf, type WorstCase } from "./worst-case.js";

/**
 * The static analyser of a v2 workflow (#272 PR 2, #270, #271): walks the flow's paths into a graph,
 * runs the data-flow engine (with outdating) to a fixed point, and checks every rule — all violations at once, before any
 * model call, in one `ConfigError.GraphRules`. Warnings (`[flow.path-too-deep]`,
 * `[graph.child-without-failure-finish]`, `[flow.committer-unreachable]`, `[judge.same-model-family]`,
 * `[limits.max-steps-below-worst-case]`, `[limits.max-steps-above-0.1.0-default]`) are errors
 * under `strict`.
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
  /** How it launches itself (#264, #1287); absent when it does not. */
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
  dtoCycleRules,
  dtoOneOfRules,
  graphRules,
  placementRules,
  cycleRules,
  countLimitRules,
  historyTtlRules,
  oneOfRules,
  textAgentRules,
  judgeOutputRules,
  errorRules,
  routerRules,
  modelRules,
  optionsRules,
  dataInputRules,
  dataOutputRules,
  outdatedRules,
  stepsRules,
  launchRules,
  quorumRules,
  branchOutdatingRules,
  childRules,
  limitHandlerRules,
  compensationRules,
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

/** The rules whose violations are warnings — errors under `strict`. */
const warningsOf = (context: AnalysisContext): readonly RuleViolation[] => [
  ...depthRules(context),
  ...childFailureWarnings(context),
  ...concurrencyWarnings(context),
  ...compensationWarnings(context),
  ...judgeFamilyWarnings(context),
  ...judgeRetryWarnings(context),
  ...worstCaseStepsWarnings(context),
  ...stepsAboveOldDefaultWarnings(context),
  ...remindBeforeWarnings(context),
];

/** The workflow's options as the rules read them: its defaults cascaded, its limits as the profiles leave them. */
const optionsFor = (
  declared: WorkflowOptions,
  defaults: WorkflowDefaults | undefined,
  executionLimits: WorkflowExecutionLimits,
): WorkflowOptions => ({
  ...declared,
  ...(defaults === undefined ? {} : { defaults }),
  executionLimits,
});

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
  const limitsOf = options.limits ?? declaredExecutionLimitsOf;
  const executionLimits = limitsOf(workflow);
  const context: AnalysisContext = {
    workflow: optionsFor(declaration.options, defaults, executionLimits),
    walked,
    graph: walked.graph,
    fields,
    dataflow,
    children,
    options,
  };
  const named = naming(declaration.options.name);
  const recursion = recursionOf(walked.graph, executionLimits.maxDepth);
  const errors = [
    ...walked.violations,
    ...unknownOptionViolations(graphClassesOf(workflow, walked.graph)),
    ...RULES.flatMap((rule) => rule(context)),
    ...recursionRules(context, workflow, recursion),
    ...concurrencyErrors(context),
  ].map(named);
  const warnings = warningsOf(context).map(named);
  const analysis: FlowAnalysis = {
    workflow: declaration.options.name,
    graph: walked.graph,
    fields,
    dataflow,
    warnings,
    children,
    worstCases: worstCasesOf(walked.graph, executionLimits, workflow, limitsOf),
    ...(recursion === undefined ? {} : { recursion }),
  };
  return options.strict === true
    ? { analysis, errors: canonical([...errors, ...warnings]), warnings: [] }
    : { analysis, errors: canonical(errors), warnings: canonical(warnings) };
}

/** Analyses a workflow; throws one `ConfigError.GraphRules` with every violation found. */
export function analyseWorkflow(workflow: Class, options: AnalyseOptions = {}): FlowAnalysis {
  const { analysis, errors } = checkWorkflow(workflow, options);
  if (errors.length > 0 || analysis === undefined)
    throw new ConfigError.GraphRules({ violations: errors });
  return analysis;
}

/** The distinct shapes of a node's input over its reachable scopes (S4; type generation reads them). */
export function inputShapesOf(analysis: FlowAnalysis, node: string): readonly InputShape[] {
  const name = node as ComponentName;
  const scopes = statesOf(analysis.dataflow, name).map((state) => state.scope);
  return projectInput(scopes, analysis.fields.get(name) ?? []);
}
