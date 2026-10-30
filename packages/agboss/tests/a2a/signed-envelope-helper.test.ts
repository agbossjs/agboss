/**
 * #521 AC2 — `signedMeshEnvelope` (`@agboss/core/testing`): an outside store's or a project's mesh
 * test signs envelopes through a public helper over the framework's own encoder. Its value is the
 * very header a real client sends, and `a2aHttpListener` trusts a request it signs exactly as it
 * trusts a real client's: the peer's origin, a signed report, deduplication by its idempotency key,
 * its budget and deadline claims, its audience.
 */
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { A2AStatus } from "../../src/a2a/index.js";
import type { MeshEnvelope } from "../../src/mesh/mesh-envelope.js";
import {
  callTool,
  replyWith,
  signedMeshEnvelope,
  TestSetupError,
  type SignedMeshEnvelopeOptions,
} from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { minutes } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { closeAll, endpoint, meshApp, opened, type Endpoint } from "./fixtures/endpoints.js";
import { meshEnvOf, meshKeyPair, meshOf, type MeshKeyPair } from "./fixtures/mesh-keys.js";

const open = opened();

afterEach(() => closeAll(open));

const body = JSON.stringify({ input: { text: "is invoice 7 paid?" } });

/** What orders-application signs for `body`, issued now; `changes` override the options. */
const optionsOf = (
  keys: MeshKeyPair,
  changes: Partial<SignedMeshEnvelopeOptions> = {},
): SignedMeshEnvelopeOptions => ({
  issuer: "orders-application",
  signingKey: keys.privateKey,
  body,
  issuedAt: new Date(),
  origin: {
    rootExecutionId: "root-1",
    executionId: "root-1",
    workflow: { name: "orders-workflow", version: "1.0.0" },
    step: {
      component: "orders-desk-agent",
      idempotencyKey: "root-1:orders-desk-agent:1:call_1",
      tool: "orders-call-peer-tool",
    },
  },
  callChain: [
    { application: "orders-application", start: "orders-workflow-start", executionId: "root-1" },
  ],
  ...changes,
});

/** billing-application, which trusts orders-application by its public key. */
async function billing(orders: MeshKeyPair, book: ScriptBook): Promise<Endpoint> {
  const served = await endpoint(open);
  await meshApp(
    open,
    served,
    {
      name: "billing",
      peerUrl: "http://unused",
      mesh: meshOf("orders-application"),
      peer: "orders-application",
    },
    book,
    { processEnv: meshEnvOf(meshKeyPair(), orders) },
  );
  return served;
}

const post = (url: string, mesh: string): Promise<Response> =>
  fetch(`${url}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json", "agboss-mesh": mesh },
    body,
  });

const payloadOf = (jws: string): MeshEnvelope =>
  JSON.parse(Buffer.from(jws.split(".")[1] ?? "", "base64url").toString("utf8")) as MeshEnvelope;

describe("#521 AC2: signedMeshEnvelope is the real client's wire format", () => {
  it("AC2: for the same call it gives the very agboss-mesh header the A2A client sent", async () => {
    const [ordersKeys, billingKeys] = [meshKeyPair(), meshKeyPair()];
    const [ordersBook, billingBook] = [new ScriptBook(), new ScriptBook()];
    const served = await endpoint(open);
    await meshApp(
      open,
      served,
      { name: "billing", peerUrl: "http://unused", mesh: meshOf("orders-application") },
      billingBook,
      { processEnv: meshEnvOf(billingKeys, ordersKeys) },
    );
    const local = await meshApp(
      open,
      await endpoint(open),
      {
        name: "orders",
        peerUrl: served.url,
        peerName: "billing",
        mesh: meshOf("billing-application"),
      },
      ordersBook,
      { processEnv: meshEnvOf(ordersKeys, billingKeys) },
    );
    ordersBook
      .scriptOf("agent:orders-desk-agent")
      .thenReturn(callTool(local.parts.CallPeer, { question: "invoice 7?" }), replyWith("Paid."));
    billingBook.scriptOf("agent:billing-desk-agent").thenReturn(replyWith("Invoice 7 is paid."));
    await execute(local.app, local.parts.MeshStart, { text: "is invoice 7 paid?" });
    const sent = String(served.headers[0]?.["agboss-mesh"]);
    const claimed = payloadOf(sent);

    const signed = signedMeshEnvelope({
      issuer: claimed.issuer,
      audience: "billing-application",
      signingKey: ordersKeys.privateKey,
      body: JSON.stringify({ input: { text: "invoice 7?" }, start: "billing-workflow-start" }),
      issuedAt: new Date(claimed.issuedAt ?? ""),
      origin: claimed.origin,
      callChain: claimed.callChain,
      ...(claimed.budget === undefined ? {} : { budget: claimed.budget }),
      ...(claimed.deadline === undefined ? {} : { deadline: claimed.deadline }),
    });

    expect(signed).toBe(sent);
  });

  it("AC2: a PEM private key (what mesh.signingKey holds) signs the same as its KeyObject", () => {
    const keys = meshKeyPair();
    const options = optionsOf(keys);

    expect(signedMeshEnvelope({ ...options, signingKey: keys.privatePem })).toBe(
      signedMeshEnvelope(options),
    );
  });

  it("AC2: the envelope carries schema 1, EdDSA, the body's hash, expiresIn and the claims", () => {
    const keys = meshKeyPair();
    const issuedAt = new Date("2026-01-05T09:00:00Z");

    const signed = signedMeshEnvelope(
      optionsOf(keys, {
        issuedAt,
        lifetime: minutes(2),
        budget: { remaining: "0.5", currency: "USD" },
        deadline: { remaining: "PT30S" },
      }),
    );

    expect(JSON.parse(Buffer.from(signed.split(".")[0] ?? "", "base64url").toString())).toEqual({
      alg: "EdDSA",
      typ: "agboss-mesh",
    });
    expect(payloadOf(signed)).toMatchObject({
      schema: 1,
      issuer: "orders-application",
      issuedAt: "2026-01-05T09:00:00.000Z",
      expiresIn: "PT120S",
      bodyHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      budget: { remaining: "0.5", currency: "USD" },
      deadline: { remaining: "PT30S" },
    });
    expect(payloadOf(signed)).not.toHaveProperty("audience");
  });

  it("AC2: a key that is not an Ed25519 private key is a TestSetupError, never an unsigned envelope", () => {
    const keys = meshKeyPair();
    const { privateKey: rsa } = generateKeyPairSync("rsa", { modulusLength: 1024 });

    expect(() => signedMeshEnvelope(optionsOf(keys, { signingKey: rsa }))).toThrow(TestSetupError);
    expect(() => signedMeshEnvelope(optionsOf(keys, { signingKey: keys.publicPem }))).toThrow(
      /Ed25519 private key/,
    );
  });
});

describe("#521 AC2: a2aHttpListener trusts what the helper signs like a real client's request", () => {
  it("AC2: trusted — finished with a signed report; a retry with the same key runs once", async () => {
    const ordersKeys = meshKeyPair();
    const book = new ScriptBook();
    const served = await billing(ordersKeys, book);
    book.scriptOf("agent:billing-desk-agent").thenReturn(replyWith("Invoice 7 is paid."));
    const mesh = signedMeshEnvelope(optionsOf(ordersKeys));

    const first: unknown = await (await post(served.url, mesh)).json();
    const retried: unknown = await (await post(served.url, mesh)).json();

    expect(first).toMatchObject({ status: A2AStatus.Finished, report: expect.any(String) });
    expect(retried).toEqual(first);
    expect(book.scriptOf("agent:billing-desk-agent").requests).toHaveLength(1);
  });

  it("AC2: its budget claim lowers the receiver's limit: Limited before any model call", async () => {
    const ordersKeys = meshKeyPair();
    const book = new ScriptBook();
    const served = await billing(ordersKeys, book);
    const broke = signedMeshEnvelope(
      optionsOf(ordersKeys, { budget: { remaining: "0", currency: "USD" } }),
    );

    const response: unknown = await (await post(served.url, broke)).json();

    expect(response).toMatchObject({ status: A2AStatus.Limited, code: "limit.budget" });
    expect(book.scriptOf("agent:billing-desk-agent").requests).toHaveLength(0);
  });

  it("AC2: another key, or an envelope for another application, is refused: 401", async () => {
    const ordersKeys = meshKeyPair();
    const book = new ScriptBook();
    const served = await billing(ordersKeys, book);

    const forged = await post(served.url, signedMeshEnvelope(optionsOf(meshKeyPair())));
    const elsewhere = await post(
      served.url,
      signedMeshEnvelope(optionsOf(ordersKeys, { audience: "invoices-application" })),
    );

    expect([forged.status, elsewhere.status]).toEqual([401, 401]);
    expect(await forged.json()).toMatchObject({ code: "mesh.signature-invalid" });
    expect(await elsewhere.json()).toMatchObject({ code: "mesh.audience-mismatch" });
    expect(book.scriptOf("agent:billing-desk-agent").requests).toHaveLength(0);
  });
});
