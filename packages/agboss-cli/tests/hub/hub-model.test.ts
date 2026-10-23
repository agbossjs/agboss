/**
 * #401 PR 3 — the mesh the Hub builds from what it read: an application only records or runs name
 * (no snapshot), a call seen from one side only, health with nothing ended, the page's layout.
 */
import { describe, expect, it } from "vitest";
import { ExecutionHistoryStatus } from "agboss";
import {
  historyRecordOf,
  toolCallOf,
} from "../../../agboss/tests/eval/fixtures/history-records.js";
import { recordsHealthOf } from "../../src/hub/derived-health.js";
import { renderHubPage } from "../../src/hub/html/hub-page.js";
import { millisecondsText } from "../../src/hub/html/health-view.js";
import { nodeCentre } from "../../src/hub/html/mesh-graph-section.js";
import type { HubInputs } from "../../src/hub/hub-inputs.js";
import { compareVersions, meshOf } from "../../src/hub/mesh.js";
import { observedCallsOf, observedEdgesOf } from "../../src/hub/observed-calls.js";

const NO_INPUTS: HubInputs = { files: [], applications: [], evalRuns: [], records: [] };

describe("#401 PR 3: the mesh from the inputs", () => {
  it("an application only a call names is in the mesh, not described; a self-call draws no arrow", () => {
    const record = historyRecordOf("r1", {
      origin: {
        application: "caller-application",
        hops: 1,
        rootExecutionId: "c1",
        executionId: "c1",
        workflow: { name: "caller-workflow", version: "1.0.0" },
        step: { component: "caller-agent", idempotencyKey: "c1:caller-agent:1:x" },
      },
    });
    const mesh = meshOf({ ...NO_INPUTS, records: [{ file: "r.jsonl", record }] });

    expect(mesh.applications.map(({ name, file }) => ({ name, file }))).toEqual([
      { name: "caller-application", file: undefined },
      { name: "sqlite-history-application", file: undefined },
    ]);
    expect(mesh.edges).toEqual([
      {
        from: "caller-application",
        to: "sqlite-history-application",
        calls: 1,
        workflows: ["caller-workflow"],
        tools: [],
      },
    ]);
    const self = observedEdgesOf([{ key: "k", from: "a", to: "a", workflow: "w" }]);
    const page = renderHubPage({ ...mesh, edges: [...mesh.edges, ...self] });
    expect(page.match(/class="mesh-edge"/gu)).toHaveLength(1);
    expect(page).toContain("not described");
  });

  it("a call the receiver's export lists first keeps the caller's tool when the caller saw it too", () => {
    const key = "c1:caller-agent:1:call-ask-tool";
    const receiver = historyRecordOf("r1", {
      origin: {
        application: "caller-application",
        hops: 1,
        rootExecutionId: "c1",
        executionId: "c1",
        workflow: { name: "caller-workflow", version: "1.0.0" },
        step: { component: "caller-agent", idempotencyKey: key },
      },
    });
    const ask = toolCallOf("ask-tool", {});
    const caller = historyRecordOf("c1", {
      application: { name: "caller-application", version: "1.0.0", instanceId: "i" },
      workflow: {
        name: "caller-workflow",
        version: "1.0.0",
        startedVersion: "1.0.0",
        configHash: "c",
      },
      toolCalls: [
        {
          ...ask,
          step: { ...ask.step, idempotencyKey: key },
          remote: { application: "sqlite-history-application", executionId: "r1" },
        },
      ],
    });

    const calls = observedCallsOf([
      { file: "receiver.jsonl", record: receiver },
      { file: "caller.jsonl", record: caller },
    ]);

    expect(calls).toEqual([
      {
        key,
        from: "caller-application",
        to: "sqlite-history-application",
        workflow: "caller-workflow",
        tool: "ask-tool",
      },
    ]);
  });

  it("health with nothing ended: no rate, no percentile; durations and versions read as people do", () => {
    const paused = historyRecordOf("p1", { status: ExecutionHistoryStatus.Paused });
    const { endedAt: _ended, ...running } = paused;

    const health = recordsHealthOf([running]);

    expect(health).toMatchObject({ executions: 1, paused: 1, failureRate: 0, errorCodes: {} });
    expect(health.p95DurationMs).toBeUndefined();
    expect([millisecondsText(850), millisecondsText(12_400), millisecondsText(186_000)]).toEqual([
      "850 ms",
      "12.4 s",
      "3.1 min",
    ]);
    expect(["1.10.0", "1.9.0", "1.2.0"].sort(compareVersions)).toEqual([
      "1.2.0",
      "1.9.0",
      "1.10.0",
    ]);
    expect(nodeCentre(0, 1)).toEqual({ x: 380, y: 220 });
    expect(meshOf(NO_INPUTS).applications).toEqual([]);
  });
});
