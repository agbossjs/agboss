/**
 * #1366 (mesh-charge shard) — what a call's mesh seam decides on its own, each rule over fakes: an agent that does not
 * declare the mesh is refused under `Required` and called without it otherwise (the price charged all the same); a call
 * to an entry the calling tree already passed through is a loop, refused before anything is sent; the envelope rides
 * only when one exists, and a `Required` call inside an execution that has none is refused; the price is charged once
 * as the service `a2a:<who>` under its ledger identity, and a completed task with no report is said so.
 */
import { HTTP_EXTENSION_HEADER, Role, TaskState, type AgentCard, type Message } from "@a2a-js/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { A2AMesh, A2AMeshUnsupportedError } from "../../../src/a2a/client/a2a-guard-errors.js";
import {
  AGBOSS_MESH,
  priceLedgerKeyOf,
  type A2ACharged,
} from "../../../src/a2a/client/a2a-mesh-seam.js";
import { A2A_MESH_EXTENSION } from "../../../src/a2a/a2a-extension-uris.js";
import { currentFrame } from "../../../src/flow/context/frame.js";
import { TRACEPARENT } from "../../../src/mesh/mesh-envelope.js";
import { MeshLoopDetectedError } from "../../../src/mesh/mesh-errors.js";
import { takeRunReport } from "../../../src/mesh/mesh-report.js";
import { currentCallChainOf, outboundMeshOfHash } from "../../../src/mesh/outbound-mesh.js";
import { usd } from "../../../src/units/index.js";

vi.mock("../../../src/flow/context/frame.js", () => ({ currentFrame: vi.fn() }));
vi.mock("../../../src/mesh/outbound-mesh.js", () => ({
  currentCallChainOf: vi.fn(),
  outboundMeshOfHash: vi.fn(),
}));
vi.mock("../../../src/mesh/mesh-report.js", () => ({ takeRunReport: vi.fn() }));

const cardWith = (...uris: string[]): AgentCard =>
  ({ capabilities: { extensions: uris.map((uri) => ({ uri })) } }) as never;
const meshed = cardWith("https://other.example/ext", A2A_MESH_EXTENSION);
const plain = cardWith("https://other.example/ext");
const peer = { name: "peer", mesh: true } as never;
const callOf = (changes: Record<string, unknown> = {}) =>
  ({
    agent: "billing-agent",
    application: "billing",
    skill: "charge",
    mesh: A2AMesh.IfSupported,
    ...changes,
  }) as never;
const charged: A2ACharged = {
  messageId: "m1",
  acceptedAt: "2030-01-01T00:00:00.000Z",
  bodyHash: "hash-1",
  taskId: "task-1",
  now: new Date("2030-01-01T00:05:00.000Z"),
};
const message: Message = {
  messageId: "m1",
  contextId: "",
  taskId: "",
  role: Role.ROLE_USER,
  parts: [],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: [],
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("#1366: a call to an agent that does not declare the mesh", () => {
  it("is refused under Required, naming the agent and the application: nothing is sent", () => {
    expect(() => AGBOSS_MESH.activate(plain, peer, callOf({ mesh: A2AMesh.Required }))).toThrow(
      new A2AMeshUnsupportedError({ agent: "billing-agent", application: "billing" }),
    );
  });

  it("is made without the mesh otherwise: the peer says so, nothing rides, nothing is settled", () => {
    const activation = AGBOSS_MESH.activate(plain, peer, callOf());

    expect(activation.peer).toEqual({ name: "peer", mesh: false });
    expect(activation.sign(message)).toEqual({ metadata: {}, serviceParameters: {} });
    expect(Object.keys(activation.sign(message))).not.toContain("bodyHash");
    activation.settle(undefined, usd(1), charged);
    expect(takeRunReport).not.toHaveBeenCalled();
  });

  it("charges the client's price as before", () => {
    const reportUsage = vi.fn();
    vi.mocked(currentFrame).mockReturnValue({ services: { reportUsage } } as never);

    AGBOSS_MESH.activate(plain, peer, callOf()).charge(usd(0.5), charged);

    expect(reportUsage).toHaveBeenCalledOnce();
  });
});

describe("#1366: the loop a call would make", () => {
  const hop = (application: string, start: string) => ({ application, start, executionId: "e" });

  it("a call to an entry the tree already passed through is refused, with the chain and the entry", () => {
    const chain = [hop("front", "ask"), hop("billing", "charge")];
    vi.mocked(currentCallChainOf).mockReturnValue(chain);

    const run = () => AGBOSS_MESH.activate(meshed, peer, callOf());

    expect(run).toThrow(
      new MeshLoopDetectedError({
        entry: { application: "billing", start: "charge" },
        chain: chain,
      }),
    );
  });

  it.each([
    ["another application", [hop("front", "charge")]],
    ["another start of the same application", [hop("billing", "refund")]],
    ["no hop", []],
  ])("a chain with %s is no loop", (_why, chain) => {
    vi.mocked(currentCallChainOf).mockReturnValue(chain);

    expect(() => AGBOSS_MESH.activate(meshed, peer, callOf())).not.toThrow();
  });

  it.each([
    ["no chain", undefined, callOf()],
    ["a call to no application", [hop("billing", "charge")], callOf({ application: undefined })],
    ["a call to no skill", [hop("billing", "charge")], callOf({ skill: undefined })],
  ])("%s is checked for no loop", (_why, chain, call) => {
    vi.mocked(currentCallChainOf).mockReturnValue(chain);

    expect(() => AGBOSS_MESH.activate(meshed, peer, call)).not.toThrow();
  });

  it("a call that names no application or no skill is no loop even when a hop names none either", () => {
    const blind = [
      { application: undefined, start: "charge", executionId: "e" },
      { application: "billing", start: undefined, executionId: "e" },
    ];
    vi.mocked(currentCallChainOf).mockReturnValue(blind as never);

    expect(() =>
      AGBOSS_MESH.activate(meshed, peer, callOf({ application: undefined })),
    ).not.toThrow();
    expect(() => AGBOSS_MESH.activate(meshed, peer, callOf({ skill: undefined }))).not.toThrow();
  });

  it("the loop is refused before the envelope is made", () => {
    vi.mocked(currentCallChainOf).mockReturnValue([hop("billing", "charge")] as never);

    expect(() => AGBOSS_MESH.activate(meshed, peer, callOf())).toThrow(MeshLoopDetectedError);
    expect(outboundMeshOfHash).not.toHaveBeenCalled();
  });
});

describe("#1366: the mesh as it rides one call", () => {
  it("is signed to an application only: a call with none says its peer is not meshed", () => {
    expect(AGBOSS_MESH.activate(meshed, peer, callOf()).peer).toEqual({ name: "peer", mesh: true });
    expect(AGBOSS_MESH.activate(meshed, peer, callOf({ application: undefined })).peer).toEqual({
      name: "peer",
      mesh: false,
    });
  });

  it("carries the envelope in the message's metadata, the extension and the trace in its headers, and the body hash it binds", () => {
    vi.mocked(outboundMeshOfHash).mockReturnValue({
      envelope: "env",
      traceparent: "00-trace",
    } as never);

    const signed = AGBOSS_MESH.activate(meshed, peer, callOf()).sign(message);

    expect(signed).toEqual({
      metadata: { [A2A_MESH_EXTENSION]: { envelope: "env" } },
      serviceParameters: { [HTTP_EXTENSION_HEADER]: A2A_MESH_EXTENSION, [TRACEPARENT]: "00-trace" },
      bodyHash: expect.stringMatching(/^sha256:/),
    });
    expect(outboundMeshOfHash).toHaveBeenCalledWith(expect.stringMatching(/^sha256:/), "billing");
  });

  it("with no envelope to send nothing rides, and under Required inside an execution that is refused", () => {
    vi.mocked(outboundMeshOfHash).mockReturnValue(undefined);

    vi.mocked(currentFrame).mockReturnValue(undefined);
    const required = AGBOSS_MESH.activate(meshed, peer, callOf({ mesh: A2AMesh.Required }));
    expect(required.sign(message)).toEqual({ metadata: {}, serviceParameters: {} });

    vi.mocked(currentFrame).mockReturnValue({} as never);
    expect(AGBOSS_MESH.activate(meshed, peer, callOf()).sign(message)).toEqual({
      metadata: {},
      serviceParameters: {},
    });
    expect(() => required.sign(message)).toThrow(
      new A2AMeshUnsupportedError({ agent: "billing-agent", application: "billing" }),
    );
  });
});

describe("#1366: what a call is charged and settled", () => {
  const reportUsage = vi.fn();

  beforeEach(() => {
    vi.mocked(currentFrame).mockReturnValue({
      services: { reportUsage, meshCall: { recordRemote: vi.fn() } },
    } as never);
  });

  it("the price is the service of the application, under the call's own ledger identity", () => {
    AGBOSS_MESH.activate(meshed, peer, callOf()).charge(usd(0.5), charged);

    expect(reportUsage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        caller: "service:a2a:billing",
        costUsd: 0.5,
        ledgerKey: priceLedgerKeyOf(charged),
      }),
    );
    expect(priceLedgerKeyOf(charged)).toEqual({
      id: "a2a:m1:price",
      madeAt: new Date("2030-01-01T00:00:00.000Z"),
    });
  });

  it("a call with no application is charged as its agent; no price, or none above zero, charges nothing", () => {
    AGBOSS_MESH.activate(meshed, peer, callOf({ application: undefined })).charge(
      usd(0.25),
      charged,
    );
    const meshOff = AGBOSS_MESH.activate(meshed, peer, callOf());
    meshOff.charge(undefined, charged);
    meshOff.charge(usd(0), charged);

    expect(reportUsage).toHaveBeenCalledOnce();
    expect(reportUsage.mock.calls[0]?.[0]).toMatchObject({
      caller: "service:a2a:billing-agent",
      model: "a2a:billing-agent",
    });
  });

  it("settles a verified report above the price, bound to the body it stored, as the call's own report", () => {
    vi.mocked(takeRunReport).mockReturnValue(true);
    const answer = { id: "task-1", status: { state: TaskState.TASK_STATE_COMPLETED } } as never;

    AGBOSS_MESH.activate(meshed, peer, callOf()).settle(answer, usd(0.5), charged);

    expect(takeRunReport).toHaveBeenCalledWith("a2a", undefined, "hash-1", undefined, 0.5, {
      id: "a2a:m1:report",
      executionId: "task-1",
      notBefore: charged.acceptedAt,
      now: charged.now,
    });
  });

  it("a call whose accept stored no body hash settles nothing", () => {
    AGBOSS_MESH.activate(meshed, peer, callOf()).settle(undefined, usd(0.5), {
      ...charged,
      bodyHash: undefined,
    });

    expect(takeRunReport).not.toHaveBeenCalled();
  });

  it("a completed task with no report this caller verifies is said so, in the step's record", () => {
    vi.mocked(takeRunReport).mockReturnValue(false);
    const recordRemote = vi.fn();
    vi.mocked(currentFrame).mockReturnValue({ services: { meshCall: { recordRemote } } } as never);
    const answer = { id: "task-1", status: { state: TaskState.TASK_STATE_COMPLETED } } as never;
    const settle = (what: unknown, price = usd(0), ids = charged) => {
      AGBOSS_MESH.activate(meshed, peer, callOf()).settle(what as never, price, ids);
    };

    settle(answer);
    expect(recordRemote).toHaveBeenCalledExactlyOnceWith({
      application: "billing",
      executionId: "task-1",
      report: false,
    });

    recordRemote.mockClear();
    settle({ id: "task-1", status: { state: TaskState.TASK_STATE_WORKING } });
    settle({ id: "task-1", status: undefined });
    settle({ messageId: "m" });
    settle(undefined);
    settle(answer, usd(0), { ...charged, taskId: undefined });
    expect(recordRemote).not.toHaveBeenCalled();
  });
});
