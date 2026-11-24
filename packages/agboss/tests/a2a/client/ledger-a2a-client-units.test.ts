/**
 * #1366 (ledger-a2a-client shard) — one call of the A2A client, the money rules on their own over fakes: the
 * peer's price charged at the accept and settled after the wait, in that order and each once; a call the agent
 * refused charged for neither, as its task says (#849); a stateless answer settled on its message (#860).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { A2AClient } from "../../../src/a2a/client/a2a-client.js";
import { accept } from "../../../src/a2a/client/a2a-accept.js";
import { activatedMeshOf } from "../../../src/a2a/client/a2a-activation.js";
import { callPeerOf } from "../../../src/a2a/client/a2a-call-peer.js";
import { CardCache } from "../../../src/a2a/client/a2a-card-cache.js";
import { a2aClientServicesOf } from "../../../src/a2a/client/a2a-client-services.js";
import { recordRefused, refusedCall, settledPeerOf } from "../../../src/a2a/client/a2a-charges.js";
import { waitForTask } from "../../../src/a2a/client/a2a-wait.js";
import { currentFrame } from "../../../src/flow/context/frame.js";
import { usd } from "../../../src/units/index.js";

vi.mock("../../../src/a2a/client/a2a-accept.js", () => ({ accept: vi.fn() }));
vi.mock("../../../src/a2a/client/a2a-activation.js", () => ({ activatedMeshOf: vi.fn() }));
vi.mock("../../../src/a2a/client/a2a-call-peer.js", () => ({ callPeerOf: vi.fn() }));
vi.mock("../../../src/a2a/client/a2a-card-cache.js", () => ({ CardCache: vi.fn() }));
vi.mock("../../../src/a2a/client/a2a-client-services.js", () => ({
  a2aClientServicesOf: vi.fn(),
  storedFileReaderOf: vi.fn(),
}));
vi.mock("../../../src/a2a/client/a2a-origins.js", () => ({
  originPolicyOf: vi.fn(() => "policy"),
}));
vi.mock("../../../src/a2a/client/a2a-outcome.js", () => ({
  outputOf: vi.fn(),
  untypedResultOf: vi.fn((settled: unknown) => settled),
}));
vi.mock("../../../src/a2a/client/a2a-wait.js", () => ({ waitForTask: vi.fn() }));
vi.mock("../../../src/a2a/client/a2a-charges.js", async (original) => ({
  ...(await original<typeof import("../../../src/a2a/client/a2a-charges.js")>()),
  refusedCall: vi.fn(),
  recordRefused: vi.fn(),
  settledPeerOf: vi.fn(),
}));
vi.mock("../../../src/flow/context/frame.js", () => ({ currentFrame: vi.fn() }));

const NOW = new Date("2026-11-21T12:00:00.000Z");
const LATER = new Date("2026-11-21T12:00:05.000Z");

/** What the fakes hold for one call. */
function setup(options: { taskId?: string | undefined; isRefused?: boolean } = {}) {
  const order: string[] = [];
  const wire = {
    client: { getTask: vi.fn(() => Promise.resolve({ id: "t" })) },
    checked: { card: { capabilities: { streaming: true } }, peer: { application: "peer" } },
    meshEchoOf: "echo",
  };
  const cards = { wireOf: vi.fn(() => Promise.resolve(wire)), fetch: vi.fn() };
  vi.mocked(CardCache).mockImplementation(function () {
    return cards;
  } as never);
  const activation = {
    peer: { application: "peer", mesh: true },
    sign: vi.fn(() => "signed"),
    charge: vi.fn(() => order.push("charge")),
    settle: vi.fn(() => order.push("settle")),
  };
  vi.mocked(activatedMeshOf).mockReturnValue({ activation, skill: "skill-1" } as never);
  const accepted = {
    messageId: "m-1",
    bodyHash: "bh",
    acceptedAt: "2026-11-21T11:59:00.000Z",
    taskId: "taskId" in options ? options.taskId : "task-1",
    task: { id: "task-1" },
    message: { messageId: "reply" },
    isRefused: options.isRefused === true,
    isMeshed: true,
  };
  vi.mocked(accept).mockImplementation((() => {
    order.push("accept");
    return Promise.resolve(accepted);
  }) as never);
  const waited = { id: "task-1", status: "done" };
  vi.mocked(waitForTask).mockImplementation((() => {
    order.push("wait");
    return Promise.resolve(waited);
  }) as never);
  vi.mocked(callPeerOf).mockReturnValue("call-peer" as never);
  vi.mocked(settledPeerOf).mockReturnValue({ application: "peer", mesh: false } as never);
  const clocks = [NOW, LATER];
  const clock = { now: vi.fn(() => clocks.shift() ?? LATER), sleep: vi.fn() };
  vi.mocked(currentFrame).mockReturnValue({
    execution: { tenant: { application: "app" } },
  } as never);
  const seam = { name: "seam" };
  vi.mocked(a2aClientServicesOf).mockReturnValue({ clock, mesh: seam } as never);
  const price = usd(0.25);
  const client = new A2AClient({
    url: "https://peer.example",
    contract: { costPerCall: price, application: "peer-app", skill: "skill-1", finishes: ["f"] },
  });
  return { client, order, wire, cards, activation, accepted, waited, clock, seam, price };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("#1366: a call charges the peer's price at the accept and settles after the wait", () => {
  it("accepts, charges, waits, settles — in that order, each once, on the task as it settled", async () => {
    const made = setup();

    const out = await made.client.send("hi");

    expect(made.order).toEqual(["accept", "charge", "wait", "settle"]);
    expect(made.activation.charge).toHaveBeenCalledOnce();
    expect(made.activation.settle).toHaveBeenCalledOnce();
    expect(made.activation.charge).toHaveBeenCalledWith(made.price, {
      messageId: "m-1",
      acceptedAt: "2026-11-21T11:59:00.000Z",
      bodyHash: "bh",
      taskId: "task-1",
      now: NOW,
    });
    expect(made.activation.settle).toHaveBeenCalledWith(made.waited, made.price, {
      messageId: "m-1",
      acceptedAt: "2026-11-21T11:59:00.000Z",
      bodyHash: "bh",
      taskId: "task-1",
      now: LATER,
    });
    expect(out).toMatchObject({
      accepted: made.accepted,
      task: made.waited,
      peer: { application: "peer", mesh: false },
    });
    expect(settledPeerOf).toHaveBeenCalledWith(made.activation, made.accepted, "peer-app");
  });

  it.each([-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, "five", null])(
    "#1382: a price of %s is refused before the card is read, the accept sent or anything charged",
    async (price) => {
      const made = setup();
      const client = new A2AClient({
        url: "https://peer.example",
        contract: { costPerCall: price as never, application: "peer-app" },
      });

      await expect(client.send("hi")).rejects.toThrow(
        /^\[a2a\.cost-per-call-invalid\] A2AClient: costPerCall is /,
      );

      expect(made.cards.wireOf).not.toHaveBeenCalled();
      expect(accept).not.toHaveBeenCalled();
      expect(made.activation.charge).not.toHaveBeenCalled();
      expect(made.activation.settle).not.toHaveBeenCalled();
    },
  );

  it("#1382: a price of 0 is a costPerCall: the call goes through", async () => {
    const made = setup();
    const client = new A2AClient({
      url: "https://peer.example",
      contract: { costPerCall: usd(0), application: "peer-app" },
    });

    await client.send("hi");

    expect(made.activation.charge).toHaveBeenCalledOnce();
  });

  it("an accept that stored no time is dated now", async () => {
    const made = setup();
    made.accepted.acceptedAt = undefined as never;

    await made.client.send("hi");

    expect(made.activation.charge).toHaveBeenCalledWith(
      made.price,
      expect.objectContaining({ acceptedAt: NOW.toISOString() }),
    );
  });

  it("a stateless answer is never waited for: it settles on its message", async () => {
    const made = setup({ taskId: undefined });

    const out = await made.client.send("hi");

    expect(waitForTask).not.toHaveBeenCalled();
    expect(made.activation.settle).toHaveBeenCalledWith(
      made.accepted.message,
      made.price,
      expect.objectContaining({ now: LATER }),
    );
    expect((out as { task: unknown }).task).toBeUndefined();
  });

  it("waits for the task as the card says: streaming, its deadline, the caller's signal and events", async () => {
    const made = setup();
    const onEvent = vi.fn();
    const controller = new AbortController();

    await made.client.send("hi", { onEvent, signal: controller.signal });

    expect(waitForTask).toHaveBeenCalledWith({
      agent: "A2AClient",
      client: made.wire.client,
      clock: expect.anything(),
      taskId: "task-1",
      task: made.accepted.task,
      isStreaming: true,
      deadlineAt: undefined,
      signal: controller.signal,
      onEvent: expect.any(Function),
    });
    // the caller's `onEvent` is given the event as AGBoss types it, never the SDK's
    const given = vi.mocked(waitForTask).mock.calls[0]?.[0].onEvent;
    given?.({ payload: { $case: "message", value: made.accepted.message as never } });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "message" }));
  });

  it("a card that does not stream is polled", async () => {
    const made = setup();
    made.wire.checked.card.capabilities.streaming = false;

    await made.client.send("hi");

    expect(vi.mocked(waitForTask).mock.calls[0]?.[0]).toMatchObject({ isStreaming: false });
  });

  it("a client without a price charges none: the seam is given none", async () => {
    const made = setup();
    const free = new A2AClient({ url: "https://peer.example" });

    await free.send("hi");

    expect(made.activation.charge).toHaveBeenCalledWith(undefined, expect.anything());
    expect(made.activation.settle).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.anything(),
    );
    expect(settledPeerOf).toHaveBeenCalledWith(made.activation, made.accepted, "A2AClient");
  });

  it("sends the message to the peer under the call's key, signed by the mesh, on the app's clock", async () => {
    const made = setup();
    const controller = new AbortController();

    await made.client.send("hi", { contextId: "ctx", key: "k1", signal: controller.signal });

    expect(activatedMeshOf).toHaveBeenCalledWith(made.wire, {
      agent: "A2AClient",
      contract: expect.objectContaining({ costPerCall: made.price }),
      seam: made.seam,
    });
    const given: Record<string, unknown> = { ...vi.mocked(accept).mock.calls[0]?.[0] };
    expect(given).toMatchObject({
      agent: "A2AClient",
      url: "https://peer.example",
      peer: "call-peer",
      client: made.wire.client,
      clock: made.clock,
      skill: "skill-1",
      contextId: "ctx",
      taskId: undefined,
      key: "k1",
      meshEchoOf: "echo",
      signal: controller.signal,
    });
    expect((given.sign as (m: unknown) => unknown)("msg")).toBe("signed");
    expect(made.activation.sign).toHaveBeenCalledWith("msg");
    expect(callPeerOf).toHaveBeenCalledWith(
      made.wire.checked.card,
      made.wire.checked.peer,
      "skill-1",
    );
    expect(made.cards.wireOf).toHaveBeenCalledWith(made.clock, controller.signal);
  });

  it("outside an execution there are no services: no mesh seam, and the system's clock", async () => {
    const made = setup();
    vi.mocked(currentFrame).mockReturnValue(undefined);

    await made.client.send("hi");

    expect(vi.mocked(activatedMeshOf).mock.calls[0]?.[1]).toMatchObject({ seam: undefined });
    const given = vi.mocked(accept).mock.calls[0]?.[0];
    expect(given?.clock.now()).toBeInstanceOf(Date);
    expect(given?.clock).not.toBe(made.clock);
  });

  it("a reply goes to the task it continues", async () => {
    const made = setup();

    await made.client.reply("task-9", "yes");

    expect(vi.mocked(accept).mock.calls[0]?.[0]).toMatchObject({ taskId: "task-9" });
  });
});

describe("#1366: a call the agent refused at the accept charges neither", () => {
  it("is handed to the refusal check: no wait, no charge, no settle by the call itself", async () => {
    const made = setup({ isRefused: true });
    vi.mocked(refusedCall).mockRejectedValue(new Error("refused"));

    await expect(made.client.send("hi")).rejects.toThrow("refused");

    expect(waitForTask).not.toHaveBeenCalled();
    expect(made.activation.charge).not.toHaveBeenCalled();
    expect(made.activation.settle).not.toHaveBeenCalled();
    expect(vi.mocked(refusedCall).mock.calls[0]?.[0]).toMatchObject({
      agent: "A2AClient",
      taskId: "task-1",
    });
  });

  it("its charge is the call's price under the accept's identity; its record says so, under the peer's application", async () => {
    const made = setup({ isRefused: true });
    vi.mocked(refusedCall).mockRejectedValue(new Error("refused"));
    await made.client.send("hi").catch(() => undefined);
    const refused = vi.mocked(refusedCall).mock.calls[0]?.[0];

    refused?.charge();
    refused?.record();

    expect(made.activation.charge).toHaveBeenCalledWith(
      made.price,
      expect.objectContaining({ messageId: "m-1", now: NOW }),
    );
    expect(recordRefused).toHaveBeenCalledWith(made.activation, made.accepted, "peer-app");
  });

  it("reads the task again with the call's signal; a client without an application names itself", async () => {
    const made = setup({ isRefused: true });
    vi.mocked(refusedCall).mockRejectedValue(new Error("refused"));
    const controller = new AbortController();
    const plain = new A2AClient({ url: "https://peer.example" });

    await plain.send("hi", { signal: controller.signal }).catch(() => undefined);
    const refused = vi.mocked(refusedCall).mock.calls[0]?.[0];
    refused?.record();
    const read = await refused?.read("task-1");

    expect(read).toEqual({ id: "t" });
    expect(made.wire.client.getTask).toHaveBeenCalledWith(
      { tenant: "", id: "task-1" },
      { signal: controller.signal },
    );
    expect(recordRefused).toHaveBeenCalledWith(made.activation, made.accepted, "A2AClient");
  });
});
