import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Class } from "../../../src/components/injection.js";
import { WorkflowStartTextDto } from "../../../src/dto/standard/framework.js";
import type { DtoClass } from "../../../src/dto/types.js";
import { NodeKind } from "../../../src/flow/ast.js";
import { runDataflow, statesOf, type Dataflow } from "../../../src/flow/analyse/dataflow.js";
import { resolveFields, type ResolvedField } from "../../../src/flow/analyse/fields.js";
import {
  EdgeKind,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from "../../../src/flow/analyse/flow-graph.js";
import { aboutRules } from "../../../src/flow/analyse/rules/about.js";
import type { AnalysisContext } from "../../../src/flow/analyse/rules/context.js";
import { dataInputRules } from "../../../src/flow/analyse/rules/data-inputs.js";
import { outdatedRules } from "../../../src/flow/analyse/rules/outdated.js";
import {
  scopeKey,
  SlotStatus,
  type AbstractScope,
  type SlotKey,
  type SlotState,
} from "../../../src/flow/analyse/scope.js";
import { declarationOf } from "../../../src/flow/decorators/declaration.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { optional } from "../../../src/flow/dto-wrappers.js";
import type { ComponentName } from "../../../src/flow/registry.js";
import type { RuleViolation } from "../../../src/graph/rule-error.js";
import { ArticleRequestDto } from "../fixtures/dtos.js";
import { CritiqueDto, DraftDto, PlanDto, ResearchDto } from "../fixtures/review-dtos.js";
import { Run } from "../../helpers/outdating-reference.js";

/**
 * #271 regression (Test cases → Regression): hundreds of random graphs and random runs through
 * them. A run is simulated value by value — every value with an id and the ids it was built from —
 * by the reference model (`tests/helpers/outdating-reference.ts`), apart from the analyser. Invariants: the abstraction of every
 * state a run reaches is one of the analyser's reachable abstract scopes (the engine is sound);
 * a run that reads an outdated value or misses a required one is reported by the rules; on a graph
 * the rules accept, no consumer receives a value built from a non-latest source, and no required
 * field is empty; an answer never outdates what it is about through the about edge.
 */

const POOL: readonly DtoClass[] = [ArticleRequestDto, ResearchDto, DraftDto, PlanDto, CritiqueDto];
const dtoAt = (index: number): DtoClass => POOL[index % POOL.length] ?? ArticleRequestDto;

interface AgentSpec {
  readonly inputs: readonly number[];
  readonly optionals: readonly boolean[];
  readonly output: number;
  readonly about: number | undefined;
  readonly readsEverything: boolean;
  readonly next: readonly number[];
}

interface GraphSpec {
  readonly agents: readonly AgentSpec[];
  readonly finishOutput: number;
  readonly startNext: number;
}

const agentArbitrary = (count: number): fc.Arbitrary<AgentSpec> =>
  fc.record({
    inputs: fc.subarray([0, 1, 2, 3, 4], { maxLength: 3 }),
    optionals: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
    output: fc.integer({ min: 1, max: 4 }),
    about: fc.option(fc.integer({ min: 0, max: 4 }), { nil: undefined, freq: 2 }),
    readsEverything: fc.integer({ min: 0, max: 5 }).map((roll) => roll === 0),
    next: fc.uniqueArray(fc.integer({ min: 0, max: count }), { minLength: 1, maxLength: 2 }),
  });

const graphArbitrary: fc.Arbitrary<GraphSpec> = fc.integer({ min: 2, max: 4 }).chain((count) =>
  fc.record({
    agents: fc.array(agentArbitrary(count), { minLength: count, maxLength: count }),
    finishOutput: fc.integer({ min: 0, max: 4 }),
    startNext: fc.integer({ min: 0, max: count - 1 }),
  }),
);

const named = (name: string): ComponentName => name as ComponentName;
const slotOfDto = (dto: DtoClass): SlotKey => dto.name as SlotKey;

function nodeOf(name: string, kind: NodeKind, component: Class): FlowNode {
  const declaration = declarationOf(component);
  if (declaration === undefined) throw new TypeError(`${name} is not decorated`);
  return { name: named(name), kind, component, declaration };
}

function agentNode(index: number, spec: AgentSpec): FlowNode {
  const input = Object.fromEntries(
    spec.inputs.map((dto, field) => {
      const shape = dtoAt(dto);
      return [`f${String(dto)}`, spec.optionals[field] === true ? optional(shape) : shape];
    }),
  );
  const options = {
    name: `p${String(index)}-agent`,
    description: "A random agent",
    prompt: "Do it.",
    model: "moonshotai/kimi-k2.6",
    output: dtoAt(spec.output),
  };
  @Agent(spec.readsEverything ? options : { ...options, input })
  class RandomAgent {}
  return nodeOf(options.name, NodeKind.Agent, RandomAgent);
}

const START = "p-workflow-start";
const FINISH = "p-workflow-finish";
const START_WRITES = [ArticleRequestDto, WorkflowStartTextDto].map((shape) => ({
  shape,
  isCase: false,
}));

function graphOf(spec: GraphSpec): FlowGraph {
  @WorkflowStart({
    name: START,
    description: "A run",
    input: { request: ArticleRequestDto, message: WorkflowStartTextDto },
  })
  class RandomWorkflowStart {}
  @WorkflowFinish({ name: FINISH, description: "The end", output: dtoAt(spec.finishOutput) })
  class RandomWorkflowFinish {}
  const agents = spec.agents.map((agent, index) => agentNode(index, agent));
  const target = (index: number): ComponentName => agents[index]?.name ?? named(FINISH);
  const edges: FlowEdge[] = [
    { from: named(START), to: target(spec.startNext), kind: EdgeKind.Next, writes: START_WRITES },
    ...spec.agents.flatMap((agent, index) =>
      agent.next.map((next): FlowEdge => ({
        from: target(index),
        to: target(next),
        kind: EdgeKind.Next,
        // `{ about }` is the flow's: on the write of the agent's value (#299 S54)
        writes: [
          agent.about === undefined
            ? { shape: dtoAt(agent.output), isCase: false }
            : { shape: dtoAt(agent.output), about: [dtoAt(agent.about)], isCase: false },
        ],
      })),
    ),
  ];
  const nodes = [
    nodeOf(START, NodeKind.Start, RandomWorkflowStart),
    nodeOf(FINISH, NodeKind.Finish, RandomWorkflowFinish),
    ...agents,
  ];
  return {
    nodes: new Map(
      nodes
        .map((node) => [node.name, node] as const)
        .sort(([first], [second]) => first.localeCompare(second)),
    ),
    edges,
    starts: [named(START)],
  };
}

const workflowOptions = (() => {
  @Workflow({ name: "property-workflow", version: "1.0.0", flow: [] })
  class PropertyWorkflow {}
  const declaration = declarationOf(PropertyWorkflow);
  if (declaration?.kind !== NodeKind.Workflow) throw new TypeError("no workflow");
  return declaration.options;
})();

interface Analysed {
  readonly graph: FlowGraph;
  readonly fields: ReadonlyMap<ComponentName, readonly ResolvedField[]>;
  readonly dataflow: Dataflow;
  readonly violations: readonly RuleViolation[];
}

function analyse(graph: FlowGraph): Analysed {
  const fields = resolveFields(graph);
  const dataflow = runDataflow(graph, fields);
  const walked = {
    graph,
    mentions: [],
    placements: [],
    switches: [],
    choices: [],
    errorHandlers: [],
    launches: [],
    joinErrorHandlers: [],
    quorumJoins: [],
    violations: [],
  };
  const context: AnalysisContext = {
    workflow: workflowOptions,
    walked,
    graph,
    fields,
    dataflow,
    children: [],
    options: {},
  };
  const violations = [
    ...dataInputRules(context),
    ...outdatedRules(context),
    ...aboutRules(context),
  ];
  return { graph, fields, dataflow, violations };
}

/** What one random run found: the problems the analyser must have reported, and the broken invariants. */
interface RunFindings {
  readonly unsound: string[];
  readonly unreported: string[];
  readonly stale: string[];
  readonly aboutBroken: readonly string[];
}

/** What a node reads: its fields, or every current value for an agent without `input` (rule 8). */
function readsOf(run: Run, analysed: Analysed, node: FlowNode): readonly SlotKey[] {
  if (node.kind === NodeKind.Start) return [];
  return node.declaration.kind === NodeKind.Agent && node.declaration.options.input === undefined
    ? run.currentSlots()
    : (analysed.fields.get(node.name) ?? []).map((field) => field.slot);
}

/** The engine is sound: the state the run is in is one the analyser found at this node. */
function checkSound(run: Run, analysed: Analysed, node: FlowNode, findings: RunFindings): void {
  const key = scopeKey(run.abstract());
  const isTooLarge = analysed.dataflow.scopes.get(node.name)?.isTooLarge === true;
  const isFound = statesOf(analysed.dataflow, node.name).some((state) => state.key === key);
  if (!isTooLarge && !isFound) findings.unsound.push(`${node.name} reached with ${key}`);
}

/** What the field read: reported by the rules when outdated or missing, and built from latest values. */
function checkRead(
  run: Run,
  analysed: Analysed,
  field: ResolvedField,
  findings: RunFindings,
): void {
  const reported = (code: string): boolean =>
    analysed.violations.some((found) => found.code === code && found.message.includes(field.label));
  const status = run.status(field.slot);
  if (status === SlotStatus.Outdated && !reported("input.outdated-on-path"))
    findings.unreported.push(`${field.label} read outdated`);
  const isMissing = status === SlotStatus.Absent && field.isRequired;
  if (isMissing && !reported("input.missing-on-path"))
    findings.unreported.push(`${field.label} missing`);
  const value = run.valueIn(field.slot);
  const stale = (value?.builtFrom ?? []).filter(
    (source) => !run.isLatest(source) && !(value?.exempt.includes(source) ?? false),
  );
  if (stale.length > 0) findings.stale.push(`${field.label} built from a non-latest value`);
}

function visit(run: Run, analysed: Analysed, node: FlowNode, findings: RunFindings): void {
  checkSound(run, analysed, node, findings);
  for (const field of analysed.fields.get(node.name) ?? [])
    checkRead(run, analysed, field, findings);
}

function simulate(analysed: Analysed, choices: readonly number[]): RunFindings {
  const findings: RunFindings = { unsound: [], unreported: [], stale: [], aboutBroken: [] };
  const run = new Run();
  let at = analysed.graph.nodes.get(named(START));
  for (let step = 0; at !== undefined && step <= choices.length; step += 1) {
    visit(run, analysed, at, findings);
    const leaving = analysed.graph.edges.filter((edge) => edge.from === at?.name);
    const edge = leaving[(choices[step] ?? 0) % Math.max(leaving.length, 1)];
    if (edge === undefined) break;
    const slots = edge.writes.flatMap((write) =>
      typeof write.shape === "function" ? [slotOfDto(write.shape)] : [],
    );
    const [target] = edge.writes.flatMap((write) => write.about ?? []);
    const about = target === undefined ? undefined : slotOfDto(target);
    run.write(edge.from, slots, readsOf(run, analysed, at), about);
    at = analysed.graph.nodes.get(edge.to);
  }
  return { ...findings, aboutBroken: run.aboutBroken };
}

describe("#271 regression: random graphs and random runs against a value-level model", () => {
  it("the analysis is sound and every run of an accepted graph reads only current, latest-built values", () => {
    fc.assert(
      fc.property(
        graphArbitrary,
        fc.array(fc.nat({ max: 7 }), { maxLength: 40 }),
        (spec, choices) => {
          const analysed = analyse(graphOf(spec));
          const findings = simulate(analysed, choices);
          const isAccepted = analysed.violations.every(
            (found) =>
              !["input.missing-on-path", "input.outdated-on-path", "io.ambiguous-cycle"].includes(
                found.code,
              ),
          );
          expect(findings.unsound).toEqual([]);
          expect(findings.unreported).toEqual([]);
          expect(findings.aboutBroken).toEqual([]);
          expect(isAccepted ? findings.stale : []).toEqual([]);
        },
      ),
      { numRuns: 400, seed: 271 },
    );
  });
});
