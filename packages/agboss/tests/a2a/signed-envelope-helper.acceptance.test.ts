/**
 * #521 AC2 acceptance corner cases (on the original's fixtures) — `signedMeshEnvelope` (`@agboss/core/testing`): an outside store's or a project's mesh
 * test signs envelopes through a public helper over the framework's own encoder. Its value is the
 * very header a real client sends, and `a2aHttpListener` trusts a request it signs exactly as it
 * trusts a real client's: the peer's origin, a signed report, deduplication by its idempotency key,
 * its budget and deadline claims, its audience.
 */
import { afterEach, describe, expect, it } from "vitest";
import { A2AStatus } from "../../src/a2a/index.js";
import {
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

describe("#521 AC2 acceptance: what the helper signs is checked like a real client's", () => {
  it("AC2: an envelope past its lifetime → 401 mesh.envelope-expired; a longer lifetime keeps it valid", async () => {
    const ordersKeys = meshKeyPair();
    const book = new ScriptBook();
    const served = await billing(ordersKeys, book);
    book.scriptOf("agent:billing-desk-agent").thenReturn(replyWith("Invoice 7 is paid."));
    const issuedAt = new Date(Date.now() - minutes(2));

    const expired = await post(served.url, signedMeshEnvelope(optionsOf(ordersKeys, { issuedAt })));
    const kept = await post(
      served.url,
      signedMeshEnvelope(optionsOf(ordersKeys, { issuedAt, lifetime: minutes(10) })),
    );

    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ code: "mesh.envelope-expired" });
    expect(await kept.json()).toMatchObject({ status: A2AStatus.Finished });
    expect(book.scriptOf("agent:billing-desk-agent").requests).toHaveLength(1);
  });

  it("AC2: signed for another body → 401 mesh.body-mismatch, nothing runs", async () => {
    const ordersKeys = meshKeyPair();
    const book = new ScriptBook();
    const served = await billing(ordersKeys, book);
    const other = JSON.stringify({ input: { text: "refund invoice 7" } });

    const swapped = await post(
      served.url,
      signedMeshEnvelope(optionsOf(ordersKeys, { body: other })),
    );

    expect(swapped.status).toBe(401);
    expect(await swapped.json()).toMatchObject({ code: "mesh.body-mismatch" });
    expect(book.scriptOf("agent:billing-desk-agent").requests).toHaveLength(0);
  });

  it("AC2: a body with non-ASCII text, an emoji and a NUL hashes as the listener reads it", async () => {
    const ordersKeys = meshKeyPair();
    const book = new ScriptBook();
    const served = await billing(ordersKeys, book);
    book.scriptOf("agent:billing-desk-agent").thenReturn(replyWith("Оплачен."));
    const unicode = JSON.stringify({ input: { text: "счёт 7 оплачен? \u{1F9FE} a\u0000b" } });

    const response = await fetch(`${served.url}/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "agboss-mesh": signedMeshEnvelope(optionsOf(ordersKeys, { body: unicode })),
      },
      body: unicode,
    });

    expect(await response.json()).toMatchObject({ status: A2AStatus.Finished });
  });

  it("AC2: an issuer the receiver has no key for stays a claim: it runs, never trusted (no signed report)", async () => {
    const ordersKeys = meshKeyPair();
    const book = new ScriptBook();
    const served = await billing(ordersKeys, book);
    book.scriptOf("agent:billing-desk-agent").thenReturn(replyWith("Invoice 7 is paid."));
    const trusted: unknown = await (
      await post(served.url, signedMeshEnvelope(optionsOf(ordersKeys)))
    ).json();
    book.scriptOf("agent:billing-desk-agent").thenReturn(replyWith("Invoice 7 is paid."));

    const stranger: unknown = await (
      await post(
        served.url,
        signedMeshEnvelope(
          optionsOf(ordersKeys, {
            issuer: "stranger-application",
            origin: {
              ...optionsOf(ordersKeys).origin,
              executionId: "root-2",
              rootExecutionId: "root-2",
            },
          }),
        ),
      )
    ).json();

    expect(trusted).toMatchObject({ status: A2AStatus.Finished, report: expect.any(String) });
    expect(stranger).toMatchObject({ status: A2AStatus.Finished });
    expect(stranger).not.toHaveProperty("report");
  });

  it("AC2: an unparsable PEM is a TestSetupError that keeps no key material", () => {
    const keys = meshKeyPair();
    const broken = "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n";

    expect(() => signedMeshEnvelope(optionsOf(keys, { signingKey: broken }))).toThrow(
      TestSetupError,
    );
    expect(() => signedMeshEnvelope(optionsOf(keys, { signingKey: broken }))).not.toThrow(
      /not-a-key/,
    );
  });
});
