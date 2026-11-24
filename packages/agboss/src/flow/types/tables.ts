import type { RuleViolation } from "../../graph/rule-error.js";
import type { FlowAnalysis } from "../analyse/analyse.js";
import { EdgeKind, outputOf, reachableFrom, type FlowNode } from "../analyse/flow-graph.js";
import type { Class } from "../../components/injection.js";
import { NodeKind } from "../ast.js";
import { onDemandRoutesOf, routesOf, type RouterOptions } from "../decorators/router.js";
import type { ComponentName } from "../registry.js";
import { TablesImport, type ImportTable } from "./imports.js";
import { childInputEntry, inputEntry, nodeInput } from "./inputs.js";
import { outputText, startInputText, startOutputText, valueText } from "./shapes.js";
import { offPathUndoActions } from "./undo-actions.js";

/**
 * The tables of `.agboss/types.d.ts` (#270 → Generated types), keyed by component `name` (S3):
 * `ProducerOutputs` (what each start, agent and action gives on its path), `Inputs` (`InputOf<X>`),
 * `Outputs` (`OutputOf<X>`: what an action or a finish returns), `WorkflowStarts` (input and output
 * per start), `Routes` (`Route<R>`: the targets a router decides on — every route after
 * `.chooseOne(…)`, the `OnDemand` ones before a launch, #280), `RouterAnswers` (what a code
 * router's `route()` returns, and what a model router's scripted `routeTo(…)` gives, #262). A
 * component in
 * several workflows gets one entry: the input shapes and the reachable finishes of all of them.
 */

/** How a router's choice continues in the flow, so what its `route()` returns (#280). */
export enum RouteForm {
  /** `.chooseOne(…)`: one target. */
  One = "one",
  /** `.toParallelAgents(…)` (#273): the `OnDemand` targets to launch; `[]` only with an `Always` route. */
  List = "list",
}

/**
 * `Route<R>` in a form: every target after `.chooseOne(…)` (spawn policies apply to launches only);
 * before a launch the `OnDemand` ones — `Always` left out, by the kind's default too (#273, #280).
 */
export function routeTargetsOf(options: RouterOptions, form: RouteForm): readonly Class[] {
  const routes = form === RouteForm.One ? routesOf(options) : onDemandRoutesOf(options);
  return routes.map((route) => route.target);
}

/** What `route()` returns in a form: `Route<R>`, or a list of it — non-empty without an `Always` route. */
export function routerAnswerText(route: string, form: RouteForm, hasAlways: boolean): string {
  if (form === RouteForm.One) return route;
  const element = route.includes(" | ") ? `(${route})` : route;
  return hasAlways ? `readonly ${element}[]` : `readonly [${element}, ...${element}[]]`;
}

/** One analysed workflow and the rule violations found in it. */
export interface AnalysedWorkflow {
  readonly analysis: FlowAnalysis;
  readonly errors: readonly RuleViolation[];
}

/** One table: entry key → its type, as printed. */
export type TypeTable = ReadonlyMap<string, string>;

export interface TypeTables {
  readonly producerOutputs: TypeTable;
  readonly inputs: TypeTable;
  readonly outputs: TypeTable;
  readonly workflowStarts: TypeTable;
  readonly routes: TypeTable;
  readonly routerAnswers: TypeTable;
  /** S4 lines for `agboss check`: the nodes whose `InputOf` is flat. */
  readonly notes: readonly string[];
}

/** Every node of every workflow, by name (the first class under a name; clashes are reported). */
function nodesOf(workflows: readonly AnalysedWorkflow[]): ReadonlyMap<ComponentName, FlowNode> {
  const nodes = new Map<ComponentName, FlowNode>();
  for (const { analysis } of workflows)
    for (const node of analysis.graph.nodes.values())
      if (!nodes.has(node.name)) nodes.set(node.name, node);
  return new Map([...nodes].sort(([first], [second]) => first.localeCompare(second)));
}

/** The routers a launch follows, in any workflow: `route()` returns a list there (#280). */
const launchingRouters = (workflows: readonly AnalysedWorkflow[]): ReadonlySet<string> =>
  new Set(
    workflows.flatMap(({ analysis }) =>
      analysis.graph.edges
        .filter((edge) => edge.kind === EdgeKind.Launch && edge.launch?.isRouterLaunch === true)
        .map((edge) => edge.from),
    ),
  );

/** The outputs of the finishes a start reaches, in every workflow it is in. */
function startOutputs(
  workflows: readonly AnalysedWorkflow[],
  start: ComponentName,
  names: ImportTable,
): string {
  const outputs = new Set<string>();
  for (const { analysis } of workflows) {
    const { graph } = analysis;
    if (!graph.nodes.has(start)) continue;
    for (const reached of reachableFrom([start], graph.edges)) {
      const node = graph.nodes.get(reached);
      if (node?.declaration.kind === NodeKind.Finish)
        outputs.add(valueText(node.declaration.options.output, names));
    }
  }
  return outputs.size === 0 ? "never" : [...outputs].sort().join(" | ");
}

/**
 * `Inputs[workflow]` (#1287): what a workflow takes — the union of its starts' inputs, as
 * `app.execute(Start, input)` takes each; `NoInput` for a workflow without a start. Printed on
 * first use, so the classes it names are imported in the order the tables meet them.
 */
function startInputsOf(
  workflows: readonly AnalysedWorkflow[],
  names: ImportTable,
): ReadonlyMap<string, () => string> {
  return new Map(
    workflows.map(({ analysis }): [string, () => string] => [
      analysis.workflow,
      () => {
        const inputs = analysis.graph.starts.flatMap((start) => {
          const declaration = analysis.graph.nodes.get(start)?.declaration;
          return declaration?.kind === NodeKind.Start
            ? [startInputText(declaration.options.input, names)]
            : [];
        });
        const union = [...new Set(inputs)].sort();
        return union.length === 0 ? names.use(TablesImport.NoInput) : union.join(" | ");
      },
    ]),
  );
}

/** The entries one node contributes to the tables other than `Inputs`. */
function writeNode(
  node: FlowNode,
  workflows: readonly AnalysedWorkflow[],
  names: ImportTable,
  tables: MutableTables,
): void {
  const { declaration, name } = node;
  switch (declaration.kind) {
    case NodeKind.Start: {
      const { input } = declaration.options;
      tables.producerOutputs.set(name, startOutputText(input, names));
      tables.inputs.set(name, startInputText(input, names));
      const output = startOutputs(workflows, name, names);
      tables.workflowStarts.set(
        name,
        `{ input: ${startInputText(input, names)}; output: ${output} }`,
      );
      return;
    }
    case NodeKind.Agent:
      tables.producerOutputs.set(name, outputText(declaration.options.output, names));
      return;
    case NodeKind.Action:
    case NodeKind.Question:
      tables.producerOutputs.set(name, outputText(declaration.options.output, names));
      tables.outputs.set(name, outputText(declaration.options.output, names));
      return;
    case NodeKind.Finish:
      tables.outputs.set(name, valueText(declaration.options.output, names));
      return;
    case NodeKind.Router: {
      const { options } = declaration;
      const form = tables.launchingRouters.has(name) ? RouteForm.List : RouteForm.One;
      const targets = routeTargetsOf(options, form).map((target) => `typeof ${names.ref(target)}`);
      const route = targets.length === 0 ? "never" : [...new Set(targets)].sort().join(" | ");
      tables.routes.set(name, route);
      const hasAlways = onDemandRoutesOf(options).length < routesOf(options).length;
      // a code router's `route()` returns it; a model router's scripted `routeTo(…)` gives it (#262)
      tables.routerAnswers.set(name, routerAnswerText(route, form, hasAlways));
      return;
    }
    case NodeKind.Workflow:
      // a child workflow gives its finishes' outputs (#263): one class or a `oneOf(…)`
      tables.producerOutputs.set(name, outputText(outputOf(node), names));
      return;
  }
}

interface MutableTables {
  readonly producerOutputs: Map<string, string>;
  readonly inputs: Map<string, string>;
  readonly outputs: Map<string, string>;
  readonly workflowStarts: Map<string, string>;
  readonly routes: Map<string, string>;
  readonly routerAnswers: Map<string, string>;
  readonly launchingRouters: ReadonlySet<string>;
  readonly notes: string[];
}

export function tablesOf(workflows: readonly AnalysedWorkflow[], names: ImportTable): TypeTables {
  const nodes = nodesOf(workflows);
  const componentOf = (name: ComponentName): FlowNode["component"] => {
    const node = nodes.get(name);
    if (node === undefined) throw new RangeError(`no node named ${name}`);
    return node.component;
  };
  const tables: MutableTables = {
    producerOutputs: new Map(),
    inputs: new Map(),
    outputs: new Map(),
    workflowStarts: new Map(),
    routes: new Map(),
    routerAnswers: new Map(),
    launchingRouters: launchingRouters(workflows),
    notes: [],
  };
  const startInputs = startInputsOf(workflows, names);
  for (const node of nodes.values()) {
    names.ref(node.component);
    writeNode(node, workflows, names, tables);
    if (node.kind === NodeKind.Start) continue;
    const input = nodeInput(workflows, node.name);
    const isChild = node.kind === NodeKind.Workflow;
    const entry = isChild
      ? childInputEntry(input, startInputs.get(node.name)?.() ?? names.use(TablesImport.NoInput))
      : inputEntry(input, names, componentOf);
    tables.inputs.set(node.name, entry.type);
    if (entry.note !== undefined) tables.notes.push(entry.note);
  }
  // a workflow no other launches takes its starts' inputs too (#1287)
  for (const [workflow, input] of startInputs)
    if (!tables.inputs.has(workflow)) tables.inputs.set(workflow, input());
  // the undo actions only the framework runs (#340): typed from their declared fields
  const nodeNames = new Set<string>(nodes.keys());
  for (const undo of offPathUndoActions(workflows, names, (name) => nodeNames.has(name))) {
    tables.inputs.set(undo.name, undo.input);
    tables.outputs.set(undo.name, undo.output);
    tables.producerOutputs.set(undo.name, undo.output);
  }
  return tables;
}
