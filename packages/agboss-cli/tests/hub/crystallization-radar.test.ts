/**
 * #401 PR 5 (AC7, S2 Q4) — the Crystallization Radar: model steps ranked by spend × stability, where
 * stability is the share of the most frequent decision among the calls with the same `inputHash`;
 * a candidate has at least 50 calls, stability ≥ 0.95 and no failing eval of its workflow. Code
 * steps (no model call) are not on it.
 */
import { describe, expect, it } from "vitest";
import { ComponentKind, type ExecutionStepRecord } from "agboss";
import { buildCostReport } from "../../../agboss/src/finops/usage.js";
import { bareRecordOf } from "../../../agboss/src/flow/runtime/records.js";
import {
  historyRecordOf,
  toolCallOf,
} from "../../../agboss/tests/eval/fixtures/history-records.js";
import { crystallizationRadarOf } from "../../src/hub/crystallization-radar.js";
import type { SuiteHealth } from "../../src/hub/derived-health.js";
import { renderHubPage } from "../../src/hub/html/hub-page.js";
import type { HubRecord } from "../../src/hub/hub-inputs.js";
import { meshOf } from "../../src/hub/mesh.js";

/** One visit of a model step: its input's hash, its decision, a cent spent on one model call. */
function stepOf(
  component: string,
  kind: ComponentKind,
  inputHash: string,
  decision: string,
  calls = 1,
): ExecutionStepRecord {
  const { step } = toolCallOf(component, {});
  return {
    step: { ...step, component: bareRecordOf(component, kind), nodeId: component },
    inputHash,
    decision,
    judgeVerdicts: [],
    guardrailDecisions: [],
    spend: { ...buildCostReport([]), calls, totalUsd: calls === 0 ? 0 : 0.01 },
    startedAt: "2026-01-05T09:00:00.000Z",
    endedAt: "2026-01-05T09:00:01.000Z",
  };
}

const recordOf = (
  executionId: string,
  workflow: string,
  steps: readonly ExecutionStepRecord[],
): HubRecord => ({
  file: "desk.jsonl",
  record: historyRecordOf(executionId, {
    application: { name: "desk-application", version: "1.0.0", instanceId: "i" },
    workflow: { name: workflow, version: "1.0.0", startedVersion: "1.0.0", configHash: workflow },
    steps,
  }),
});

const range = (count: number): number[] => Array.from({ length: count }, (_, index) => index);

/** 60 executions of the desk: a stable router, an agent that never sees an input twice, … */
const RECORDS: readonly HubRecord[] = [
  ...range(60).map((index) =>
    recordOf(`d${String(index)}`, "desk-workflow", [
      // two inputs, 30 calls each; one of the second's 30 goes the other way: 59 of 60 agree
      stepOf(
        "triage-router",
        ComponentKind.Router,
        index % 2 === 0 ? "h-order" : "h-refund",
        index === 1
          ? "route:order-agent"
          : index % 2 === 0
            ? "route:order-agent"
            : "route:refund-agent",
      ),
      stepOf("writer-agent", ComponentKind.Agent, `h-${String(index)}`, `answer:${String(index)}`),
      stepOf("lookup-router", ComponentKind.Router, "h-same", "route:x", 0), // a code router: no model call
    ]),
  ),
  ...range(10).map((index) =>
    recordOf(`s${String(index)}`, "summary-workflow", [
      stepOf("summary-agent", ComponentKind.Agent, "h-s", "answer:same"),
    ]),
  ),
  ...range(60).map((index) =>
    recordOf(`g${String(index)}`, "gate-workflow", [
      stepOf("gate-router", ComponentKind.Router, "h-g", "route:done"),
    ]),
  ),
];

/** The gate workflow's eval run: one case failed pass^k. */
const SUITES: readonly SuiteHealth[] = [
  {
    suite: "gate-eval-suite",
    workflow: "gate-workflow",
    file: "gate.run.json",
    endedAt: "2026-01-05T10:00:00.000Z",
    cases: 4,
    passAtK: 4,
    passHatK: 3,
    unstable: 1,
    runs: 3,
  },
];

describe("#401 PR 5: the crystallization radar", () => {
  it("ranks model steps by spend × stability, candidates first; code steps are left out", () => {
    const radar = crystallizationRadarOf(RECORDS, () => SUITES);

    expect(
      radar.map(({ component, calls, stability, isCandidate, passHatK }) => ({
        component,
        calls,
        stability,
        isCandidate,
        passHatK,
      })),
    ).toEqual([
      {
        component: "triage-router",
        calls: 60,
        stability: 59 / 60,
        isCandidate: true,
        passHatK: undefined,
      },
      { component: "gate-router", calls: 60, stability: 1, isCandidate: false, passHatK: false },
      {
        component: "summary-agent",
        calls: 10,
        stability: 1,
        isCandidate: false,
        passHatK: undefined,
      },
      {
        component: "writer-agent",
        calls: 60,
        stability: undefined,
        isCandidate: false,
        passHatK: undefined,
      },
    ]);
    const [triage] = radar;
    expect(triage).toMatchObject({
      repeatedInputs: 2,
      repeatedCalls: 60,
      kind: ComponentKind.Router,
      workflow: "desk-workflow",
    });
    expect(triage?.spendUsd).toBeCloseTo(0.6);
    expect(triage?.score).toBeCloseTo(0.6 * (59 / 60));
    expect(triage?.executions).toHaveLength(20);
    expect(radar.find((step) => step.component === "lookup-router")).toBeUndefined();
  });

  it("the page lists the radar with its rule; without model steps it says so", () => {
    const page = renderHubPage(
      meshOf({ files: [], applications: [], evalRuns: [], records: RECORDS }),
    );

    expect(page).toContain("Crystallization radar");
    expect(page).toContain("A candidate has at least 50 calls");
    expect(page).toContain("98.3% over 2 inputs (60 calls)");
    expect(page).toContain('class="radar-candidate"');
    expect(
      renderHubPage(meshOf({ files: [], applications: [], evalRuns: [], records: [] })),
    ).toContain("No model step in the records.");
  });
});
