import { ComponentKind, type ChildExecutionRecord, type ExecutionStepRecord } from "@agboss/core";
import type { SuiteHealth } from "./derived-health.js";
import type { HubRecord } from "./hub-inputs.js";

/**
 * The Progressive Crystallization Radar (#401 PR 5, S2 Q4): the model steps across the mesh worth
 * turning into code (`DecidedBy.Code`, an `@Action`) — those that spend much and decide the same
 * way for the same input. Deterministic, from the records only:
 *
 * - per agent and model router (a step with model calls) of a workflow of an application;
 * - **stability** = the share of the most frequent decision among the calls with the same
 *   `inputHash`, over the inputs seen at least twice (`ExecutionStepRecord.decision`: a router's
 *   route, a `oneOf` variant, else the answer's hash) — none without a repeated input;
 * - **score** = spend × stability;
 * - a **candidate** has at least 50 calls, stability ≥ 0.95, and pass^k on every case of the
 *   latest run of each eval suite of its workflow, where one exists.
 */

/** The fewest calls a step needs to be a candidate. */
export const RADAR_MIN_CALLS = 50;

/** The least stability of a candidate. */
export const RADAR_MIN_STABILITY = 0.95;

/** How many executions of a step the radar names. */
const SHOWN_EXECUTIONS = 20;

/** One model step of the mesh, as the radar ranks it. */
export interface RadarStep {
  readonly application: string;
  readonly workflow: string;
  readonly component: string;
  readonly kind: ComponentKind;
  readonly calls: number;
  readonly spendUsd: number;
  /** 0–1; undefined when no input was seen twice. */
  readonly stability: number | undefined;
  /** The inputs seen at least twice, and the calls they had. */
  readonly repeatedInputs: number;
  readonly repeatedCalls: number;
  /** pass^k of its workflow's suites; undefined without one. */
  readonly passHatK: boolean | undefined;
  readonly score: number;
  readonly isCandidate: boolean;
  /** The first executions it ran in (by the records' order), for reading them. */
  readonly executions: readonly string[];
}

/** One model call of a step, with where it ran. */
interface ModelCall {
  readonly key: string;
  readonly application: string;
  readonly workflow: string;
  readonly executionId: string;
  readonly step: ExecutionStepRecord;
}

const MODEL_KINDS: ReadonlySet<string> = new Set([ComponentKind.Agent, ComponentKind.Router]);

/** What made steps: a root's record or a child's. */
interface Stepping {
  readonly executionId: string;
  readonly workflow: { readonly name: string };
  readonly steps: readonly ExecutionStepRecord[];
  readonly children: readonly ChildExecutionRecord[];
}

function modelCalls(application: string, execution: Stepping): ModelCall[] {
  const own = execution.steps
    .filter((step) => MODEL_KINDS.has(step.step.component.kind) && step.spend.calls > 0)
    .map((step) => ({
      key: `${application}\u0000${execution.workflow.name}\u0000${step.step.component.name}`,
      application,
      workflow: execution.workflow.name,
      executionId: execution.executionId,
      step,
    }));
  return [...own, ...execution.children.flatMap((child) => modelCalls(application, child))];
}

/** The share of the most frequent decision per repeated input, over their calls. */
function stabilityOf(calls: readonly ModelCall[]) {
  const byInput = new Map<string, string[]>();
  for (const { step } of calls)
    byInput.set(step.inputHash, [...(byInput.get(step.inputHash) ?? []), step.decision ?? ""]);
  let repeatedInputs = 0;
  let repeatedCalls = 0;
  let agreeing = 0;
  for (const decisions of byInput.values()) {
    if (decisions.length < 2) continue;
    const counts = new Map<string, number>();
    for (const decision of decisions) counts.set(decision, (counts.get(decision) ?? 0) + 1);
    repeatedInputs += 1;
    repeatedCalls += decisions.length;
    agreeing += Math.max(...counts.values());
  }
  const stability = repeatedCalls === 0 ? undefined : agreeing / repeatedCalls;
  return { stability, repeatedInputs, repeatedCalls };
}

/** pass^k on every case of the latest run of each suite of the workflow; undefined without one. */
function passHatKOf(suites: readonly SuiteHealth[], workflow: string): boolean | undefined {
  const own = suites.filter((suite) => suite.workflow === workflow);
  return own.length === 0 ? undefined : own.every((suite) => suite.passHatK === suite.cases);
}

/** Whether a step is ready to become code: enough calls, stable, and no failing eval. */
const isCandidateStep = (
  calls: number,
  stability: number | undefined,
  passHatK: boolean | undefined,
): boolean =>
  calls >= RADAR_MIN_CALLS &&
  stability !== undefined &&
  stability >= RADAR_MIN_STABILITY &&
  passHatK !== false;

/** Which step the calls are of: the first call's. */
const identityOf = (call: ModelCall) => ({
  application: call.application,
  workflow: call.workflow,
  component: call.step.step.component.name,
  kind: call.step.step.component.kind,
});

function radarStepOf(
  first: ModelCall,
  calls: readonly ModelCall[],
  suites: readonly SuiteHealth[],
): RadarStep {
  const spendUsd = calls.reduce((total, call) => total + call.step.spend.totalUsd, 0);
  const { stability, repeatedInputs, repeatedCalls } = stabilityOf(calls);
  const passHatK = passHatKOf(suites, first.workflow);
  return {
    ...identityOf(first),
    calls: calls.length,
    spendUsd,
    stability,
    repeatedInputs,
    repeatedCalls,
    passHatK,
    score: spendUsd * (stability ?? 0),
    isCandidate: isCandidateStep(calls.length, stability, passHatK),
    executions: [...new Set(calls.map((call) => call.executionId))].slice(0, SHOWN_EXECUTIONS),
  };
}

/** Every model step of the records, candidates first, then by score, then by name. */
export function crystallizationRadarOf(
  records: readonly HubRecord[],
  suitesOf: (application: string) => readonly SuiteHealth[],
): RadarStep[] {
  const groups = new Map<string, ModelCall[]>();
  for (const { record } of records)
    for (const call of modelCalls(record.application.name, record))
      groups.set(call.key, [...(groups.get(call.key) ?? []), call]);
  return [...groups.values()]
    .flatMap((calls) => {
      const [first] = calls;
      return first === undefined ? [] : [radarStepOf(first, calls, suitesOf(first.application))];
    })
    .sort(
      (left, right) =>
        Number(right.isCandidate) - Number(left.isCandidate) ||
        right.score - left.score ||
        `${left.application}/${left.workflow}/${left.component}`.localeCompare(
          `${right.application}/${right.workflow}/${right.component}`,
        ),
    );
}
