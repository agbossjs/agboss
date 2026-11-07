/**
 * #844: a meshed call is never settled at its price alone in silence.
 * Its completed task with no run report this caller verifies is recorded `remote: { …, report:
 * false }` in the step's record; one with a verified report is charged it and recorded as the
 * report says; a task that did not complete, or a call that knows no task, records nothing.
 */
import { generateKeyPairSync } from "node:crypto";
import { TaskState, type Task } from "@a2a-js/sdk";
import { describe, expect, it } from "vitest";
import { A2A_MESH_EXTENSION } from "../../../src/a2a/a2a-extension-uris.js";
import { A2APeerKind } from "../../../src/a2a/client/a2a-card.js";
import { A2AMesh } from "../../../src/a2a/client/a2a-guard-errors.js";
import { AGBOSS_MESH, type A2ACharged } from "../../../src/a2a/client/a2a-mesh-seam.js";
import type { UsageRecord } from "../../../src/finops/usage.js";
import { runInFrame } from "../../../src/flow/context/frame.js";
import type { ToolCallRemote } from "../../../src/mesh/mesh-call.js";
import { encodeRunReport } from "../../../src/mesh/mesh-report.js";
import { rememberContextMeshSettings, type MeshSettings } from "../../../src/mesh/mesh-settings.js";
import { VirtualClock } from "../../../src/testing/index.js";
import { hours, usd } from "../../../src/units/index.js";
import { scripts, SdkAgent } from "./support/sdk-agent.js";

const PEER = "peer-application";
const BODY = "body-hash";
const TASK = "t-1";
const NOW = new Date("2026-11-04T12:05:00.000Z");
const peerKeys = generateKeyPairSync("ed25519");

/** An AGBoss agent's card: it declares the mesh extension. */
const card = new SdkAgent({
  script: scripts.completeWith({ data: {} }),
  agboss: { idempotencyRetention: hours(1) },
}).card;

const charged = (taskId: string | undefined): A2ACharged => ({
  messageId: "m-1",
  acceptedAt: "2026-11-04T12:00:00.000Z",
  bodyHash: BODY,
  taskId,
  now: NOW,
});

const taskOf = (state: TaskState, report?: string): Task => ({
  id: TASK,
  contextId: "c-1",
  status: { state, message: undefined, timestamp: NOW.toISOString() },
  artifacts: [],
  history: [],
  metadata: report === undefined ? undefined : { [A2A_MESH_EXTENSION]: { report } },
});

const signedReport = (spentUsd: number): string =>
  encodeRunReport(
    { issuer: PEER, executionId: TASK, spentUsd, bodyHash: BODY, issuedAt: NOW },
    peerKeys.privateKey,
  );

/** Settles `task` in a tool call's frame of a caller that knows the peer's key; what it did. */
async function settled(task: Task | undefined, isTaskKnown = true) {
  const remotes: ToolCallRemote[] = [];
  const usage: UsageRecord[] = [];
  const application = {};
  const settings: MeshSettings = {
    application: "caller-application",
    maxMeshHops: 8,
    keys: { peers: new Map([[PEER, peerKeys.publicKey]]) },
    clock: new VirtualClock(NOW),
    idempotencyRetention: hours(1),
    a2aTaskRetention: hours(1),
    exposes: [],
    contracts: () => Promise.reject(new Error("no contracts in a unit")),
  };
  rememberContextMeshSettings(application as never, settings);
  const meshCall = {
    tool: "ask-peer-tool",
    remainingBudget: () => undefined,
    deadlineAt: NOW,
    recordRemote: (remote: ToolCallRemote) => remotes.push(remote),
  };
  const spec = {
    execution: { tenant: { application } },
    step: {},
    services: { meshCall, reportUsage: (record: UsageRecord) => usage.push(record) },
  } as never;
  const activation = AGBOSS_MESH.activate(
    card,
    { kind: A2APeerKind.AGBoss, idempotencyRetention: hours(1), mesh: true },
    {
      agent: "peer-a2a-agent",
      application: PEER,
      skill: "ask-workflow-start",
      mesh: A2AMesh.Required,
    },
  );
  await runInFrame(spec, () => {
    activation.settle(task, usd(1), charged(isTaskKnown ? TASK : undefined));
    return Promise.resolve();
  });
  return { remotes, charged: usage.reduce((sum, record) => sum + record.costUsd, 0) };
}

describe("#844: a meshed call's settle says when no report was verified", () => {
  it("AC1: a completed task with no report: charged nothing above the price, recorded report: false", async () => {
    expect(await settled(taskOf(TaskState.TASK_STATE_COMPLETED))).toEqual({
      remotes: [{ application: PEER, executionId: TASK, report: false }],
      charged: 0,
    });
  });

  it("a report signed by another key is none verified: report: false", async () => {
    const stranger = generateKeyPairSync("ed25519");
    const forged = encodeRunReport(
      { issuer: PEER, executionId: TASK, spentUsd: 3, bodyHash: BODY, issuedAt: NOW },
      stranger.privateKey,
    );
    expect((await settled(taskOf(TaskState.TASK_STATE_COMPLETED, forged))).remotes).toEqual([
      { application: PEER, executionId: TASK, report: false },
    ]);
  });

  it("a verified report: its excess charged, the remote as the report says, no report: false", async () => {
    expect(await settled(taskOf(TaskState.TASK_STATE_COMPLETED, signedReport(3)))).toEqual({
      remotes: [{ application: PEER, executionId: TASK }],
      charged: 2,
    });
  });

  it("a task that did not complete, or a call that knows no task: nothing recorded", async () => {
    expect((await settled(taskOf(TaskState.TASK_STATE_FAILED))).remotes).toEqual([]);
    expect((await settled(undefined)).remotes).toEqual([]);
    expect((await settled(taskOf(TaskState.TASK_STATE_COMPLETED), false)).remotes).toEqual([]);
  });
});
