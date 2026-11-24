/**
 * #844: a meshed call is never settled at its price alone in silence.
 * Its completed task with no run report this caller verifies is recorded `remote: { …, report:
 * false }` in the step's record; one with a verified report is charged it and recorded as the
 * report says; a task that did not complete, or a call that knows no task, records nothing.
 */
import { MESH_DEFAULTS } from "../../helpers/mesh-settings.js";
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
import { encodeRunReport, takeRunReport } from "../../../src/mesh/mesh-report.js";
import { rememberContextMeshSettings, type MeshSettings } from "../../../src/mesh/mesh-settings.js";
import { VirtualClock } from "../../../src/testing/index.js";
import { hours, UnitError, usd } from "../../../src/units/index.js";
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

const signedReport = (spent: number, executionId = TASK, issuedAt = NOW): string =>
  encodeRunReport(
    { issuer: PEER, executionId, spentUsd: usd(spent), bodyHash: BODY, issuedAt },
    peerKeys.privateKey,
  );

/** Runs `settle` outside any frame, in a frame, or in the continuation of a frame that has returned: closed. */
async function settledAt(
  where: "frame" | "outside" | "closed",
  spec: never,
  settle: () => void,
): Promise<void> {
  if (where === "outside") settle();
  else if (where === "frame")
    await runInFrame(spec, () => {
      settle();
      return Promise.resolve();
    });
  else {
    let later: Promise<void> = Promise.resolve();
    await runInFrame(spec, () => {
      later = new Promise((resolve) => {
        setImmediate(() => {
          settle();
          resolve();
        });
      });
      return Promise.resolve();
    });
    await later;
  }
}

/** The price a call has (1 unless said) and its accept as stored, with the body hash the options give it. */
function callOf(
  isTaskKnown: boolean,
  options: { price?: number | undefined; bodyHash?: string | undefined },
) {
  const call = { ...charged(isTaskKnown ? TASK : undefined) };
  if ("bodyHash" in options) call.bodyHash = options.bodyHash;
  return { price: "price" in options ? options.price : 1, call };
}

/** Settles `task` in a tool call's frame of a caller that knows the peer's key; what it did. */
async function settled(
  task: Task | undefined,
  isTaskKnown = true,
  options: {
    price?: number | undefined;
    bodyHash?: string | undefined;
    where?: "frame" | "outside" | "closed";
    withoutServices?: boolean;
    withoutSettings?: boolean;
    /** The report taken as an MCP call does: no price, no identity of the call. */
    asMcp?: boolean;
  } = {},
) {
  const { where = "frame", withoutServices = false, withoutSettings = false } = options;
  const { price, call } = callOf(isTaskKnown, options);
  const remotes: ToolCallRemote[] = [];
  const usage: UsageRecord[] = [];
  const application = {};
  const settings: MeshSettings = {
    application: "caller-application",
    maxMeshHops: 8,
    keys: { peers: new Map([[PEER, [peerKeys.publicKey]]]) },
    ...MESH_DEFAULTS,
    clock: new VirtualClock(NOW),
    idempotencyRetention: hours(1),
    a2aTaskRetention: hours(1),
    a2aFileRetention: hours(1),
    a2aMessageRetention: hours(1),
    workflows: [],
    exposes: [],
    contracts: () => Promise.reject(new Error("no contracts in a unit")),
  };
  if (!withoutSettings) rememberContextMeshSettings(application as never, settings);
  const meshCall = {
    tool: "ask-peer-tool",
    remainingBudget: () => undefined,
    deadlineAt: NOW,
    recordRemote: (remote: ToolCallRemote) => remotes.push(remote),
  };
  const spec = {
    execution: { tenant: { application } },
    step: {},
    services: withoutServices
      ? {}
      : { meshCall, reportUsage: (record: UsageRecord) => usage.push(record) },
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
  await settledAt(where, spec, () => {
    if (options.asMcp === true)
      takeRunReport("mcp", task?.metadata?.[A2A_MESH_EXTENSION]?.report, BODY);
    else activation.settle(task, price === undefined ? undefined : usd(price), call);
  });
  return {
    remotes,
    charged: usage.reduce((sum, record) => sum + record.costUsd, 0),
    callers: usage.map((record) => record.caller),
    keys: usage.map((record) => ({
      id: record.ledgerKey?.id,
      madeAt: record.ledgerKey?.madeAt.toISOString(),
    })),
  };
}

describe("#1382: a settle at a price that is no amount charges nothing and throws", () => {
  it.each([-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "a price of %s with a report of $3 is not charged above it",
    async (price) => {
      await expect(
        settled(taskOf(TaskState.TASK_STATE_COMPLETED, signedReport(3)), true, { price }),
      ).rejects.toThrow(UnitError);
    },
  );

  it("a price of 0 settles the report whole", async () => {
    const out = await settled(taskOf(TaskState.TASK_STATE_COMPLETED, signedReport(3)), true, {
      price: 0,
    });
    expect(out.charged).toBe(3);
  });
});

describe("#844: a meshed call's settle says when no report was verified", () => {
  it("AC1: a completed task with no report: charged nothing above the price, recorded report: false", async () => {
    const out = await settled(taskOf(TaskState.TASK_STATE_COMPLETED));

    expect(out.remotes).toEqual([{ application: PEER, executionId: TASK, report: false }]);
    expect(out.charged).toBe(0);
  });

  it("a report signed by another key is none verified: report: false", async () => {
    const stranger = generateKeyPairSync("ed25519");
    const forged = encodeRunReport(
      { issuer: PEER, executionId: TASK, spentUsd: usd(3), bodyHash: BODY, issuedAt: NOW },
      stranger.privateKey,
    );
    expect((await settled(taskOf(TaskState.TASK_STATE_COMPLETED, forged))).remotes).toEqual([
      { application: PEER, executionId: TASK, report: false },
    ]);
  });

  it("a verified report: its excess charged, the remote as the report says, no report: false", async () => {
    const out = await settled(taskOf(TaskState.TASK_STATE_COMPLETED, signedReport(3)));

    expect(out.remotes).toEqual([{ application: PEER, executionId: TASK }]);
    expect(out.charged).toBe(2);
    expect(out.callers).toEqual([`service:a2a:${PEER}`]);
  });

  it("a task that did not complete, or a call that knows no task: nothing recorded", async () => {
    expect((await settled(taskOf(TaskState.TASK_STATE_FAILED))).remotes).toEqual([]);
    expect((await settled(undefined)).remotes).toEqual([]);
    expect((await settled(taskOf(TaskState.TASK_STATE_COMPLETED), false)).remotes).toEqual([]);
  });
});

describe("#1366: what a meshed call's settle charges, and where", () => {
  const completed = (report?: string) => taskOf(TaskState.TASK_STATE_COMPLETED, report);

  it("a call with no price is charged the verified spend alone, as the service of the peer that signed it", async () => {
    const out = await settled(completed(signedReport(3)), true, { price: undefined });

    expect(out.charged).toBe(3);
    expect(out.callers).toEqual([`service:a2a:${PEER}`]);
    expect(out.remotes).toEqual([{ application: PEER, executionId: TASK }]);
  });

  it("a call that was not meshed, with no body hash to bind a report to, settles nothing", async () => {
    expect(await settled(completed(signedReport(3)), true, { bodyHash: undefined })).toMatchObject({
      charged: 0,
      remotes: [],
      callers: [],
    });
  });

  it("outside a step, or in a frame that has closed, nothing is charged", async () => {
    for (const where of ["outside", "closed"] as const)
      expect(await settled(completed(signedReport(3)), true, { where })).toMatchObject({
        charged: 0,
        callers: [],
      });
  });

  it("outside a step nothing is recorded of the call either; in a frame that has closed, only that no report was taken", async () => {
    const outside = await settled(completed(signedReport(3)), true, { where: "outside" });
    const closed = await settled(completed(signedReport(3)), true, { where: "closed" });

    expect(outside.remotes).toEqual([]);
    expect(closed.remotes).toEqual([{ application: PEER, executionId: TASK, report: false }]);
  });

  it("the charge of a report is one ledger entry of the call's own id, dated inside the caller's window", async () => {
    const out = await settled(
      completed(signedReport(3, TASK, new Date("2026-11-04T12:03:00.000Z"))),
    );
    const backdated = await settled(
      completed(signedReport(3, TASK, new Date("1970-01-01T00:00:00.000Z"))),
    );

    expect(out.keys).toEqual([{ id: "a2a:m-1:report", madeAt: "2026-11-04T12:03:00.000Z" }]);
    expect(backdated.keys[0]?.madeAt).toBe("2026-11-04T12:00:00.000Z");
  });

  it("a report of another execution than the call's task counts nothing; the call's own task is what it names", async () => {
    const other = await settled(completed(signedReport(3, "other-task")));
    const unknownTask = await settled(completed(signedReport(3, "other-task")), false);

    expect(other.charged).toBe(0);
    expect(other.remotes).toEqual([{ application: PEER, executionId: TASK, report: false }]);
    // a call that knows no task has none to name: the report is the call's by its body alone
    expect(unknownTask.charged).toBe(2);
  });

  it("a report taken with no identity of the call, as an MCP call takes it, is the call's by its body alone", async () => {
    const out = await settled(completed(signedReport(3, "any-task")), true, { asMcp: true });

    expect(out.charged).toBe(3);
    expect(out.callers).toEqual([`service:mcp:${PEER}`]);
    expect(out.remotes).toEqual([{ application: PEER, executionId: "any-task" }]);
    expect(out.keys).toEqual([{ id: undefined, madeAt: undefined }]);
  });

  it("a caller with no mesh settings verifies no report and charges none", async () => {
    const out = await settled(completed(signedReport(3)), true, { withoutSettings: true });

    expect(out.charged).toBe(0);
    expect(out.remotes).toEqual([{ application: PEER, executionId: TASK, report: false }]);
  });

  it("a frame with no services to charge or record to settles without either", async () => {
    expect(
      await settled(completed(signedReport(3)), true, { withoutServices: true }),
    ).toMatchObject({
      charged: 0,
      remotes: [],
    });
  });
});
