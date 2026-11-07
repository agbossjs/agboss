/**
 * #810 AC4, AC6 — the A2A server's inbound mesh check on the wire, before anything runs: a raw
 * JSON-RPC `SendMessage` to the real listener with the envelope the test signs. The audience is
 * checked first, against the application's own name, whoever signed it (fail closed — with no
 * mesh settings too); then a known issuer's signature, its replay window, and the `bodyHash` of the
 * message as the server decodes it. Each refusal is `401 { code }` and nothing runs. A chain the
 * application refuses is a REJECTED task carrying the limit's code and facts.
 */
import "./fixtures/keys.js";
import type { KeyObject } from "node:crypto";
import { Message } from "@a2a-js/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { A2A_MESH_EXTENSION } from "../../../src/a2a/index.js";
import { meshBodyHashOf } from "../../../src/a2a/a2a-mesh-message.js";
import { encodeMeshEnvelope } from "../../../src/mesh/mesh-envelope-codec.js";
import type { MeshEnvelope } from "../../../src/mesh/mesh-envelope.js";
import type { MeshHop } from "../../../src/mesh/mesh-hop.js";
import { meshLimitErrorOf } from "../../../src/mesh/mesh-wire.js";
import { MeshLoopDetectedError } from "../../../src/index.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { resetCaller } from "./fixtures/caller/caller.application.js";
import { CALLER_KEYS, STRANGER_KEYS } from "./fixtures/keys.js";
import {
  CALLER_TOKEN,
  KeylessPeerApplication,
  OTHER_PEER_TOKEN,
  STRANGER_TOKEN,
  peer,
  PEER_APPLICATION,
  resetPeer,
} from "./fixtures/peer/peer.application.js";
import { servePeer, type ServedPeer } from "./fixtures/serve-peer.js";

const served: ServedPeer[] = [];
let clock: VirtualClock;

beforeEach(() => {
  resetCaller();
  resetPeer();
  clock = new VirtualClock();
});

afterEach(async () => {
  await Promise.all(served.splice(0).map((one) => one.close()));
});

const CALLER_HOP: MeshHop = {
  application: "caller-application",
  start: "caller-workflow-start",
  executionId: "caller-execution-1",
};

/** A user message's wire JSON, as a client sends it (no mesh entry yet). */
const messageOf = (messageId: string, text = "is invoice 7 paid?"): Record<string, unknown> => ({
  messageId,
  role: "ROLE_USER",
  parts: [{ text }],
});

/** The `bodyHash` the server computes: of the message as the SDK decodes it, its mesh entry out. */
const bodyHashOf = (message: unknown): string =>
  meshBodyHashOf(Message.toJSON(Message.fromJSON(message)));

interface EnvelopeSpec {
  readonly issuer?: string;
  /** `null`: no audience at all. */
  readonly audience?: string | null;
  /** `null`: unsigned. */
  readonly key?: KeyObject | null;
  readonly issuedAt?: Date;
  readonly bodyHash?: string;
  readonly chain?: readonly MeshHop[];
}

/** An envelope for `message` (by default: the caller's, signed, to the peer, of this body). */
function envelopeOf(message: unknown, spec: EnvelopeSpec = {}): string {
  const envelope: MeshEnvelope = {
    schema: 1,
    issuer: spec.issuer ?? "caller-application",
    ...(spec.audience === null ? {} : { audience: spec.audience ?? PEER_APPLICATION }),
    origin: {
      rootExecutionId: "caller-execution-1",
      executionId: "caller-execution-1",
      workflow: { name: "caller-workflow", version: "1.0.0" },
      step: { component: "ask-peer-action", idempotencyKey: "caller-execution-1:ask:1" },
    },
    callChain: [...(spec.chain ?? [CALLER_HOP])],
    issuedAt: (spec.issuedAt ?? clock.now()).toISOString(),
    expiresIn: "PT60S",
    bodyHash: spec.bodyHash ?? bodyHashOf(message),
    budget: { remaining: "4", currency: "USD" },
  };
  const key = spec.key === null ? undefined : (spec.key ?? CALLER_KEYS.privateKey);
  return encodeMeshEnvelope(envelope, key);
}

/** The message with its envelope in `metadata[mesh-uri]`. */
const withEnvelope = (message: Record<string, unknown>, envelope: string) => ({
  ...message,
  metadata: { [A2A_MESH_EXTENSION]: { envelope } },
});

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly extensions: string | null;
}

/** One raw JSON-RPC `SendMessage` of `message` to the served peer, as `token`. */
async function sent(
  peerServed: ServedPeer,
  message: unknown,
  token = CALLER_TOKEN,
): Promise<Answer> {
  const response = await fetch(`${peerServed.origin}/a2a`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "a2a-version": "1.0",
      "a2a-extensions": A2A_MESH_EXTENSION,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "SendMessage",
      params: { message, configuration: { returnImmediately: true } },
    }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body, extensions: response.headers.get("a2a-extensions") };
}

const taskOf = (answer: Answer): Record<string, unknown> =>
  (answer.body.result as { task: Record<string, unknown> }).task;

/** One raw JSON-RPC call of `method` to the served peer, as `token`: its result. */
async function called(
  peerServed: ServedPeer,
  method: string,
  params: unknown,
  token = CALLER_TOKEN,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${peerServed.origin}/a2a`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "a2a-version": "1.0",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
  });
  return (await response.json()) as Record<string, unknown>;
}

/** The task of an accepted message once it completed, as `GetTask` shows it to `token`. */
async function completed(
  peerServed: ServedPeer,
  answer: Answer,
  token = CALLER_TOKEN,
): Promise<{ readonly metadata?: Record<string, unknown> }> {
  const id = taskOf(answer).id;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const read = await called(peerServed, "GetTask", { id }, token);
    const task = read.result as { status: { state: string }; metadata?: Record<string, unknown> };
    if (task.status.state === "TASK_STATE_COMPLETED") return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`task ${String(id)} never completed`);
}

/** Whether a task's metadata carries a run report. */
const hasReport = (task: { readonly metadata?: Record<string, unknown> }): boolean =>
  typeof (task.metadata?.[A2A_MESH_EXTENSION] as { report?: unknown } | undefined)?.report ===
  "string";

describe("#810 AC6: the audience is checked first, against the application's own name", () => {
  it("AC6: a signed envelope with no audience is 401 mesh.audience-missing; nothing runs", async () => {
    const one = await servePeer(clock);
    served.push(one);
    const message = messageOf("m-1");

    const answer = await sent(one, withEnvelope(message, envelopeOf(message, { audience: null })));

    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ code: "mesh.audience-missing" });
    expect(peer.runs).toEqual([]);
  });

  it("AC6: an envelope addressed to another application is 401 mesh.audience-mismatch", async () => {
    const one = await servePeer(clock);
    served.push(one);
    const message = messageOf("m-1");
    const elsewhere = envelopeOf(message, { audience: "third-application" });

    const answer = await sent(one, withEnvelope(message, elsewhere));

    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ code: "mesh.audience-mismatch" });
    expect(peer.runs).toEqual([]);
  });

  it("AC6: the audience before the signature — a forged one without an audience is audience-missing, never signature-invalid", async () => {
    const one = await servePeer(clock);
    served.push(one);
    const message = messageOf("m-1");
    const forgedNoAudience = envelopeOf(message, { audience: null, key: STRANGER_KEYS.privateKey });
    const forgedElsewhere = envelopeOf(message, {
      audience: "third-application",
      key: STRANGER_KEYS.privateKey,
    });

    const missing = await sent(one, withEnvelope(message, forgedNoAudience));
    const mismatch = await sent(one, withEnvelope(message, forgedElsewhere));

    expect(missing.body).toMatchObject({ code: "mesh.audience-missing" });
    expect(mismatch.body).toMatchObject({ code: "mesh.audience-mismatch" });
  });

  it("AC6: fail closed with no mesh settings — the application's own name is still the audience", async () => {
    const one = await servePeer(clock, KeylessPeerApplication);
    served.push(one);
    const message = messageOf("m-1");

    const missing = await sent(one, withEnvelope(message, envelopeOf(message, { audience: null })));
    const mismatch = await sent(
      one,
      withEnvelope(message, envelopeOf(message, { audience: "third-application" })),
    );
    // an unsigned claim for someone else is refused too: it only restricts
    const unsigned = await sent(
      one,
      withEnvelope(message, envelopeOf(message, { audience: "third-application", key: null })),
    );

    expect([missing.status, mismatch.status, unsigned.status]).toEqual([401, 401, 401]);
    expect(missing.body).toMatchObject({ code: "mesh.audience-missing" });
    expect(mismatch.body).toMatchObject({ code: "mesh.audience-mismatch" });
    expect(unsigned.body).toMatchObject({ code: "mesh.audience-mismatch" });
    expect(peer.runs).toEqual([]);
  });
});

describe("#810 AC4: a forged, expired or rebound envelope is 401 before anything runs", () => {
  it("AC4: signed by another key than the issuer's: 401 mesh.signature-invalid", async () => {
    const one = await servePeer(clock);
    served.push(one);
    const message = messageOf("m-1");

    const answer = await sent(
      one,
      withEnvelope(message, envelopeOf(message, { key: STRANGER_KEYS.privateKey })),
    );

    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ code: "mesh.signature-invalid" });
    expect(peer.runs).toEqual([]);
  });

  it("AC4: issued past its lifetime: 401 mesh.envelope-expired", async () => {
    const one = await servePeer(clock);
    served.push(one);
    const message = messageOf("m-1");
    const issuedAt = new Date(clock.now().getTime() - 5 * 60_000);

    const answer = await sent(one, withEnvelope(message, envelopeOf(message, { issuedAt })));

    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ code: "mesh.envelope-expired" });
    expect(peer.runs).toEqual([]);
  });

  it("AC4: signed for another message: 401 mesh.body-mismatch — the envelope cannot be moved", async () => {
    const one = await servePeer(clock);
    served.push(one);
    const signedFor = messageOf("m-1", "pay invoice 7");
    const envelope = envelopeOf(signedFor);

    const moved = await sent(one, withEnvelope(messageOf("m-1", "pay invoice 9"), envelope));

    expect(moved.status).toBe(401);
    expect(moved.body).toMatchObject({ code: "mesh.body-mismatch" });
    expect(peer.runs).toEqual([]);
  });

  it("a valid envelope runs, its extension echoed (spec §4.6)", async () => {
    const one = await servePeer(clock);
    served.push(one);
    const message = messageOf("m-1");

    const answer = await sent(one, withEnvelope(message, envelopeOf(message)));

    expect(answer.status).toBe(200);
    expect(answer.extensions).toContain(A2A_MESH_EXTENSION);
    expect(taskOf(answer).id).toEqual(expect.any(String));
  });
});

describe("#810 AC1: a refused chain is a REJECTED task with the limit's facts", () => {
  it("AC1: a loop through the peer's own skill → REJECTED limit.mesh-loop, the same error rebuilt; a resend gets it again; nothing runs", async () => {
    const one = await servePeer(clock);
    served.push(one);
    const message = messageOf("m-loop");
    const looped = envelopeOf(message, {
      chain: [
        { application: PEER_APPLICATION, start: "ask-workflow-start", executionId: "p-0" },
        CALLER_HOP,
      ],
    });

    const answer = await sent(one, withEnvelope(message, looped));
    const again = await sent(one, withEnvelope(message, looped));

    const task = taskOf(answer);
    const status = task.status as {
      state: string;
      message: { metadata: Record<string, unknown> };
    };
    expect(status.state).toBe("TASK_STATE_REJECTED");
    const facts = status.message.metadata[A2A_MESH_EXTENSION];
    expect(facts).toMatchObject({
      code: "limit.mesh-loop",
      details: { entry: { application: PEER_APPLICATION } },
    });
    expect(meshLimitErrorOf(facts)).toBeInstanceOf(MeshLoopDetectedError);
    expect(taskOf(again).id).toBe(task.id);
    expect(peer.runs).toEqual([]);
  });
});

describe("#810: what is trusted — the resolver's peer that signed it, nothing else", () => {
  it("the peer that signed it: its completed task carries the signed run report", async () => {
    const one = await servePeer(clock);
    served.push(one);
    const message = messageOf("m-trusted");

    const answer = await sent(one, withEnvelope(message, envelopeOf(message)));

    expect(hasReport(await completed(one, answer))).toBe(true);
  });

  it("an unsigned envelope naming a known issuer is a claim: it runs, untrusted — no report", async () => {
    const one = await servePeer(clock);
    served.push(one);
    const message = messageOf("m-unsigned");

    const answer = await sent(one, withEnvelope(message, envelopeOf(message, { key: null })));

    expect(answer.status).toBe(200);
    expect(hasReport(await completed(one, answer))).toBe(false);
  });

  it("a signed envelope of an issuer the peer does not know is a claim: it runs, untrusted", async () => {
    const one = await servePeer(clock);
    served.push(one);
    const message = messageOf("m-unknown-issuer");
    const envelope = envelopeOf(message, {
      issuer: "stranger-application",
      key: STRANGER_KEYS.privateKey,
    });

    const answer = await sent(one, withEnvelope(message, envelope));

    expect(answer.status).toBe(200);
    expect(hasReport(await completed(one, answer))).toBe(false);
  });

  it("a valid envelope sent by a caller of no peer, or of another peer: untrusted — no report", async () => {
    const one = await servePeer(clock);
    served.push(one);
    const first = messageOf("m-stranger");
    const second = messageOf("m-other");

    const stranger = await sent(one, withEnvelope(first, envelopeOf(first)), STRANGER_TOKEN);
    const other = await sent(one, withEnvelope(second, envelopeOf(second)), OTHER_PEER_TOKEN);

    expect(hasReport(await completed(one, stranger, STRANGER_TOKEN))).toBe(false);
    expect(hasReport(await completed(one, other, OTHER_PEER_TOKEN))).toBe(false);
  });

  it("a send with no message is -32602, never a failure of the check", async () => {
    const one = await servePeer(clock);
    served.push(one);

    const read = await called(one, "SendMessage", {});

    expect(read.error).toMatchObject({ code: -32602 });
  });
});
