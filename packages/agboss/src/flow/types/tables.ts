import type { RuleViolation } from "../../graph/rule-error.js";
import { inputShapesOf, type FlowAnalysis } from "../analyse/analyse.js";
import { EdgeKind, reachableFrom, type FlowNode } from "../analyse/flow-graph.js";
import { joinValueWrites } from "../analyse/launches.js";
import { slotOfWrite } from "../analyse/scope.js";
import type { InputShape } from "../analyse/projection.js";
import { NodeKind, type ComponentClass } from "../ast.js";
import {
  isCodeRouter,
  onDemandRoutesOf,
  routesOf,
  type RouterOptions,
} from "../decorators/router.js";
import type { ComponentName } from "../registry.js";
import type { ImportTable } from "./imports.js";
import { inputEntry, type NodeInput } from "./inputs.js";
import { joinEntries } from "./joins.js";
import { outputText, startInputText, startOutputText, valueText } from "./shapes.js";

/**
 * The tables of `.agboss/types.d.ts` (#270 → Generated types), keyed by component `name` (S3):
 * `ProducerOutputs` (what each start, agent and action gives on its path), `Inputs` (`InputOf<X>`),
 * `Outputs` (`OutputOf<X>`: what an action or a finish returns), `WorkflowStarts` (input and output
 * per start), `Routes` (`Route<R>`: the targets a router decides on — every route after
 * `.chooseOne(…)`, the `OnDemand` ones before a launch, #280), `RouterAnswers` (what a code
 * router's `route()` returns) and `JoinOutputs` (what the join of each launch gives, #273). A
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
export function routeTargetsOf(options: RouterOptions, form: RouteForm): readonly ComponentClass[] {
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
  readonly joinOutputs: TypeTable;
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

/** The problems an input's type reports: the data rules, and a per-item target's unread item. */
const isInputProblem = (found: RuleViolation): boolean =>
  found.code.startsWith("input.") || found.code === "launch.item-not-read";

/** The routers a launch follows, in any workflow: `route()` returns a list there (#280). */
const launchingRouters = (workflows: readonly AnalysedWorkflow[]): ReadonlySet<string> =>
  new Set(
    workflows.flatMap(({ analysis }) =>
      analysis.graph.edges
        .filter((edge) => edge.kind === EdgeKind.Launch && edge.launch?.isRouterLaunch === true)
        .map((edge) => edge.from),
    ),
  );

function nodeInput(workflows: readonly AnalysedWorkflow[], name: ComponentName): NodeInput {
  const shapes = new Map<string, InputShape>();
  const problems = new Set<string>();
  const versionProducers = new Map<string, ComponentName[]>();
  let fields: NodeInput["fields"] = [];
  for (const { analysis, errors } of workflows) {
    if (!analysis.graph.nodes.has(name)) continue;
    fields = (analysis.fields.get(name) ?? []).filter((field) => !field.isPassThrough);
    for (const field of fields.filter((candidate) => candidate.history !== undefined)) {
      const { edges } = analysis.graph;
      const writers = [
        ...edges
          .filter((edge) => edge.writes.some((write) => slotOfWrite(write) === field.slot))
          .map((edge) => edge.from),
        ...joinValueWrites(edges)
          .filter(({ write }) => slotOfWrite(write) === field.slot)
          .flatMap(({ producers }) => producers),
      ];
      versionProducers.set(field.name, [...(versionProducers.get(field.name) ?? []), ...writers]);
    }
    for (const shape of inputShapesOf(analysis, name)) shapes.set(JSON.stringify(shape), shape);
    for (const found of errors)
      if (isInputProblem(found) && found.nodes.includes(name))
        problems.add(`[${found.code}] ${found.message}`);
  }
  return {
    name,
    fields,
    shapes: [...shapes.values()],
    versionProducers,
    problems: [...problems].sort(),
  };
}

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
      const hasAlways = onDemandRoutesOf(options).length < options.routes.length;
      if (isCodeRouter(options))
        tables.routerAnswers.set(name, routerAnswerText(route, form, hasAlways));
      return;
    }
    case NodeKind.Workflow:
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
  for (const node of nodes.values()) {
    names.ref(node.component);
    writeNode(node, workflows, names, tables);
    if (node.kind === NodeKind.Start) continue;
    const entry = inputEntry(nodeInput(workflows, node.name), names, componentOf);
    tables.inputs.set(node.name, entry.type);
    if (entry.note !== undefined) tables.notes.push(entry.note);
  }
  return { ...tables, joinOutputs: joinEntries(workflows, names) };
}
