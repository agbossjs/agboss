/**
 * #809 — the A2A v1.0 client inside an execution: the accept round trip through `OutboundCalls`
 * (an ambiguous send resent with the same messageId to an AGBoss peer, never to a foreign one), the
 * mesh envelope on the message (the call chain refused at a loop and past the hop limit, the budget
 * passed down), the deadline's cancel and the local price.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  A2ACallDeadlineError,
  A2AContractError,
  A2AContractRule,
  A2AMesh,
  A2AMeshUnsupportedError,
} from "../../../src/a2a/index.js";
import { OutboundCallUnreconciledError } from "../../../src/app/outbound-calls.js";
import { HopsLimitExceededError, MeshLoopDetectedError } from "../../../src/index.js";
import type { App } from "../../../src/app/types.js";
import { hours, seconds, usd } from "../../../src/units/index.js";
import { audienceRefusalOf, MeshRefusalCode } from "../../../src/mesh/mesh-verification.js";
import { readMeshEnvelope } from "../../../src/mesh/mesh-envelope-codec.js";
import { meshKeyPair } from "../fixtures/mesh-keys.js";
import { callerOf } from "./fixtures/caller.js";
import { scripts, SdkAgent, workingThen } from "./support/sdk-agent.js";

const apps: App[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const caller = async (spec: Parameters<typeof callerOf>[0]) => {
  const parts = await callerOf(spec);
  apps.push(parts.app);
  return parts;
};

const AGBOSS = { idempotencyRetention: hours(24) };
const PEER = { application: "peer-application", skill: "ask-workflow-start" };

describe("#809: the accept round trip through OutboundCalls", () => {
  it("an ambiguous send to an AGBoss peer is resent with the same messageId: one task", async () => {
    const agent = new SdkAgent({
      script: scripts.completeWith({ data: { text: "paid" } }),
      agboss: AGBOSS,
    });
    agent.loseSendAnswers = 1; // the agent accepted the message, its answer never arrived
    const { ask, replies, errors } = await caller({ agent, target: PEER });

    await ask("is invoice 7 paid?");

    const sends = agent.received.filter((request) => request.method === "SendMessage");
    expect(sends).toHaveLength(2);
    expect(sends[1]?.messageId).toBe(sends[0]?.messageId); // the same message, deduplicated
    expect(errors).toEqual([]);
    expect(replies).toEqual([{ text: "paid" }]);
  });

  it("an ambiguous send to a foreign peer is never resent: OutboundCallUnreconciledError", async () => {
    const agent = new SdkAgent({ script: scripts.completeWith({ data: { text: "paid" } }) });
    agent.loseSendAnswers = 1;
    const { ask, errors } = await caller({ agent });

    await ask("is invoice 7 paid?").catch(() => undefined);

    expect(agent.count("SendMessage")).toBe(1); // nothing sent again
    expect(errors[0]).toBeInstanceOf(OutboundCallUnreconciledError);
    expect((errors[0] as OutboundCallUnreconciledError).reason).toMatch(/foreign A2A peer/);
  });

  it("the messageId is the call's: the same on every attempt, another for another step", async () => {
    const agent = new SdkAgent({
      script: scripts.completeWith({ data: { text: "ok" } }),
      agboss: AGBOSS,
    });
    const { ask } = await caller({ agent, target: PEER });

    await ask("first");
    await ask("second");

    const [first, second] = agent.received.map((request) => request.messageId);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(second).not.toBe(first);
  });

  it("two calls of one step with other messages need their own key: [a2a.repeated-call]", async () => {
    const agent = new SdkAgent({
      script: scripts.completeWith({ data: { text: "ok" } }),
      agboss: AGBOSS,
    });
    const { ask, errors } = await caller({ agent, target: PEER, callsPerRun: 2 });

    await ask("twice").catch(() => undefined);

    expect(agent.count("SendMessage")).toBe(1);
    expect(errors[0]).toBeInstanceOf(A2AContractError);
    expect((errors[0] as A2AContractError).rule).toBe(A2AContractRule.RepeatedCall);
  });
});

describe("#809: the mesh rides an AGBoss call", () => {
  it("the envelope is on the message: the chain with the caller's own hop, the budget, bound to the body", async () => {
    const agent = new SdkAgent({
      script: scripts.completeWith({ data: { text: "ok" } }),
      agboss: AGBOSS,
    });
    const { ask } = await caller({ agent, target: PEER });

    await ask("hello");

    const [carried] = agent.envelopes;
    expect(carried?.isBodyBound).toBe(true);
    expect(carried?.envelope).toMatchObject({
      issuer: "caller-application",
      audience: "peer-application",
      callChain: [{ application: "caller-application", start: "caller-workflow-start" }],
      budget: { currency: "USD" },
    });
    expect(Number(carried?.envelope.budget?.remaining)).toBeGreaterThan(0); // the budget passed down
    expect(agent.received[0]?.headers["a2a-extensions"]).toContain(
      "https://agboss.dev/a2a/mesh/v1",
    );
    expect(agent.received[0]?.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u);
  });

  it("a chain past the receiver's maxMeshHops is refused there: the same HopsLimitExceededError", async () => {
    const agent = new SdkAgent({
      script: scripts.completeWith({ data: { text: "ran" } }),
      agboss: AGBOSS,
      meshReceiver: {
        entry: { application: "peer-application", start: "ask-workflow-start" },
        maxMeshHops: 1,
      },
    });
    const { ask, errors } = await caller({ agent, target: PEER });

    await ask("hello").catch(() => undefined);

    expect(errors[0]).toBeInstanceOf(HopsLimitExceededError);
    expect(errors[0]).toMatchObject({ maxMeshHops: 1, entry: { application: "peer-application" } });
  });

  it("a loop A → A is refused before anything is sent", async () => {
    const agent = new SdkAgent({
      script: scripts.completeWith({ data: { text: "ran" } }),
      agboss: AGBOSS,
      skills: ["caller-workflow-start"],
    });
    const self = { application: "caller-application", skill: "caller-workflow-start" };
    const { ask, errors } = await caller({ agent, target: self });

    await ask("hello").catch(() => undefined);

    expect(errors[0]).toBeInstanceOf(MeshLoopDetectedError);
    expect(agent.count("SendMessage")).toBe(0);
  });

  it("an AGBoss target without the mesh extension is refused: A2AMeshUnsupportedError, nothing sent", async () => {
    const agent = new SdkAgent({ script: scripts.completeWith({ data: { text: "ran" } }) });
    const { ask, errors } = await caller({ agent, target: PEER });

    await ask("hello").catch(() => undefined);

    expect(errors[0]).toBeInstanceOf(A2AMeshUnsupportedError);
    expect(agent.count("SendMessage")).toBe(0);
  });

  it("IfSupported calls it without the mesh, and sends no envelope", async () => {
    const agent = new SdkAgent({ script: scripts.completeWith({ data: { text: "ran" } }) });
    const { ask, replies } = await caller({ agent, target: PEER, mesh: A2AMesh.IfSupported });

    await ask("hello");

    expect(replies).toEqual([{ text: "ran" }]);
    expect(agent.envelopes).toEqual([]);
  });
});

describe("#809 security: a signed envelope always names its audience", () => {
  it("a call to a target application is signed and addressed to it; replayed to a third app it is refused", async () => {
    const [own, peer] = [meshKeyPair(), meshKeyPair()];
    const agent = new SdkAgent({
      script: scripts.completeWith({ data: { text: "ok" } }),
      agboss: AGBOSS,
    });
    const { ask } = await caller({ agent, target: PEER, signing: { own, peer } });

    await ask("hello");

    const [carried] = agent.envelopes;
    const read = readMeshEnvelope(carried?.text);
    expect(carried).toMatchObject({ isSigned: true, envelope: { audience: "peer-application" } });
    expect(
      read === undefined ? undefined : audienceRefusalOf(read, "peer-application"),
    ).toBeUndefined();
    // the same signed envelope, sent on by the peer to another application
    expect(read === undefined ? undefined : audienceRefusalOf(read, "third-application")).toBe(
      MeshRefusalCode.AudienceMismatch,
    );
  });

  it("a client with no target application sends no signature: an unsigned claim only", async () => {
    const [own, peer] = [meshKeyPair(), meshKeyPair()];
    const agent = new SdkAgent({
      script: scripts.completeWith({ data: { text: "ok" } }),
      agboss: AGBOSS,
    });
    const { ask, replies } = await caller({ agent, signing: { own, peer } });

    await ask("hello");

    expect(replies).toEqual([{ text: "ok" }]);
    expect(agent.envelopes).toHaveLength(1);
    expect(agent.envelopes[0]).toMatchObject({ isSigned: false });
    expect(agent.envelopes[0]?.envelope.audience).toBeUndefined();
  });
});

describe("#809: the deadline and the price", () => {
  it("at the call's deadline the task is canceled and the call fails A2ACallDeadlineError", async () => {
    const agent = new SdkAgent({ script: workingThen() });
    const { ask, errors } = await caller({ agent, timeout: seconds(0.3) });

    await ask("slow").catch(() => undefined);

    expect(errors[0]).toBeInstanceOf(A2ACallDeadlineError);
    expect(errors[0]).toMatchObject({ isCanceled: true });
    expect(agent.count("CancelTask")).toBe(1);
  });

  it("a foreign peer's call is charged the client's price in the step's spend", async () => {
    const agent = new SdkAgent({ script: scripts.completeWith({ data: { text: "ok" } }) });
    const { ask } = await caller({ agent, price: usd(0.25) });

    const result = await ask("price me");

    expect(result.spend.byModel["a2a:caller-peer-a2a-agent"]).toBeCloseTo(0.25);
  });
});
