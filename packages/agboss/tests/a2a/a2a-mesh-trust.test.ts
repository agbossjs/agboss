import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { A2AClient, A2AStatus } from "../../src/a2a/index.js";
import { encodeMeshEnvelope } from "../../src/mesh/mesh-envelope-codec.js";
import type { MeshEnvelope } from "../../src/mesh/mesh-envelope.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { usd } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { closeAll, endpoint, meshApp, opened, type Endpoint } from "./fixtures/endpoints.js";
import { meshEnvOf, meshKeyPair, meshOf, type MeshKeyPair } from "./fixtures/mesh-keys.js";
import { meshVerifierOf } from "./fixtures/mesh-verifier.js";
import type { MeshAppSpec } from "./fixtures/mesh.workflow.js";

const open = opened();

afterEach(() => closeAll(open));

const body = JSON.stringify({ input: { text: "is invoice 7 paid?" } });

const hashOf = (text: string): string =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** An envelope orders-application signs for `body`, issued now; `changes` override its fields. */
function signedEnvelope(
  key: MeshKeyPair,
  changes: Partial<MeshEnvelope> = {},
  idempotencyKey = "root-1:orders-desk-agent:1:call_1",
): string {
  const envelope: MeshEnvelope = {
    schema: 1,
    issuer: "orders-application",
    origin: {
      rootExecutionId: "root-1",
      executionId: "root-1",
      workflow: { name: "orders-workflow", version: "1.0.0" },
      step: { component: "orders-desk-agent", idempotencyKey, tool: "orders-call-peer-tool" },
    },
    callChain: [
      { application: "orders-application", start: "orders-workflow-start", executionId: "root-1" },
    ],
    issuedAt: new Date().toISOString(),
    expiresIn: "PT60S",
    bodyHash: hashOf(body),
    ...changes,
  };
  return encodeMeshEnvelope(envelope, key.privateKey);
}

/** billing-application, which trusts orders-application (the resolver names it as the peer). */
async function billing(
  orders: MeshKeyPair,
  own: MeshKeyPair,
  book: ScriptBook,
  spec: Partial<MeshAppSpec> = {},
): Promise<{ readonly served: Endpoint; readonly started: Awaited<ReturnType<typeof meshApp>> }> {
  const served = await endpoint(open);
  const started = await meshApp(
    open,
    served,
    {
      name: "billing",
      peerUrl: "http://unused",
      mesh: meshOf("orders-application"),
      peer: "orders-application",
      ...spec,
    },
    book,
    { processEnv: meshEnvOf(own, orders) },
  );
  return { served, started };
}

const post = (url: string, mesh: string, text = body): Promise<Response> =>
  fetch(`${url}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json", "agboss-mesh": mesh },
    body: text,
  });

describe("#398 PR 2: a trusted peer's call — signed envelope, origin, report", () => {
  it("A → B signed: B runs for A's origin, A records B's spend and B's execution", async () => {
    const [ordersKeys, billingKeys] = [meshKeyPair(), meshKeyPair()];
    const [ordersBook, billingBook] = [new ScriptBook(), new ScriptBook()];
    const { served, started: remote } = await billing(ordersKeys, billingKeys, billingBook);
    const ordersAt = await endpoint(open);
    const local = await meshApp(
      open,
      ordersAt,
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
    billingBook
      .scriptOf("agent:billing-desk-agent")
      .thenReturn(replyWith("Invoice 7 is paid.", { cost: usd(0.25) }));

    const result = await execute(local.app, local.parts.MeshStart, { text: "is invoice 7 paid?" });

    const header = String(served.headers[0]?.["agboss-mesh"]);
    const [jwsHeader] = header.split(".");
    expect(JSON.parse(Buffer.from(jwsHeader ?? "", "base64url").toString("utf8"))).toEqual({
      alg: "EdDSA",
      typ: "agboss-mesh",
    });
    const [remoteStart] = remote.parts.started;
    expect(remoteStart?.origin).toMatchObject({
      application: "orders-application",
      rootExecutionId: result.executionId,
      executionId: result.executionId,
      step: { component: "orders-desk-agent", tool: "orders-call-peer-tool" },
      hops: 1, // the applications before this one
    });
    expect(result.toolCalls[0]?.remote).toEqual({
      application: "billing-application",
      executionId: remoteStart?.executionId,
    });
    expect(result.spend.byModel["a2a:billing-application"]).toBeCloseTo(0.25); // B's own report
    expect(result.spend.byCaller["tool:orders-call-peer-tool"]).toBeCloseTo(0.25);
    expect(local.parts.started[0]?.origin).toBeUndefined(); // a root has no origin
  });

  it("an envelope the peer did not sign is no trust: no origin, no report, no remote", async () => {
    const [ordersBook, billingBook] = [new ScriptBook(), new ScriptBook()];
    const served = await endpoint(open);
    const remote = await meshApp(
      open,
      served,
      { name: "billing", peerUrl: "http://unused" },
      billingBook,
    );
    const ordersAt = await endpoint(open);
    const local = await meshApp(
      open,
      ordersAt,
      { name: "orders", peerUrl: served.url, peerName: "billing" },
      ordersBook,
    );
    ordersBook
      .scriptOf("agent:orders-desk-agent")
      .thenReturn(callTool(local.parts.CallPeer, { question: "q" }), replyWith("ok"));
    billingBook
      .scriptOf("agent:billing-desk-agent")
      .thenReturn(replyWith("a", { cost: usd(0.25) }));

    const result = await execute(local.app, local.parts.MeshStart, { text: "go" });

    expect(remote.parts.started[0]?.origin).toBeUndefined();
    expect(result.toolCalls[0]?.remote).toBeUndefined();
    expect(result.spend.byModel["a2a:billing-application"]).toBeUndefined();
  });

  it("a trusted caller's budget and deadline lower the receiver's own", async () => {
    const [ordersKeys, billingKeys] = [meshKeyPair(), meshKeyPair()];
    const book = new ScriptBook();
    const { served } = await billing(ordersKeys, billingKeys, book);

    const broke = await post(
      served.url,
      signedEnvelope(ordersKeys, { budget: { remaining: "0", currency: "USD" } }, "k-budget"),
    );
    const late = await post(
      served.url,
      signedEnvelope(ordersKeys, { deadline: { remaining: "PT0S" } }, "k-deadline"),
    );

    const brokeJson: unknown = await broke.json();
    expect(brokeJson).toMatchObject({
      status: A2AStatus.Limited,
      code: "limit.budget",
      error: expect.stringContaining("caller-budget allows $0"),
    });
    expect(await late.json()).toMatchObject({ status: A2AStatus.Limited, code: "limit.deadline" });
    expect(book.scriptOf("agent:billing-desk-agent").requests).toHaveLength(0);
  });

  it("an untrusted caller's budget and deadline are ignored", async () => {
    const book = new ScriptBook();
    const served = await endpoint(open);
    await meshApp(open, served, { name: "billing", peerUrl: "http://unused" }, book);
    book.scriptOf("agent:billing-desk-agent").thenReturn(replyWith("ok"));
    const unsigned = encodeMeshEnvelope({
      schema: 1,
      issuer: "orders-application",
      origin: {
        rootExecutionId: "r",
        executionId: "r",
        workflow: { name: "orders-workflow", version: "1.0.0" },
        step: { component: "orders-desk-agent", idempotencyKey: "r:1" },
      },
      callChain: [],
      budget: { remaining: "0", currency: "USD" },
      deadline: { remaining: "PT0S" },
    });

    const response = await post(served.url, unsigned);

    expect(await response.json()).toMatchObject({ status: A2AStatus.Finished });
  });
});

describe("#398 PR 2: a bad signed envelope is refused before anything runs", () => {
  it("another key's signature, an expired envelope, a body it did not sign: 401", async () => {
    const [ordersKeys, billingKeys, forger] = [meshKeyPair(), meshKeyPair(), meshKeyPair()];
    const book = new ScriptBook();
    const { served, started } = await billing(ordersKeys, billingKeys, book);
    const longAgo = new Date(Date.now() - 3_600_000).toISOString();

    const forged = await post(served.url, signedEnvelope(forger));
    const expired = await post(served.url, signedEnvelope(ordersKeys, { issuedAt: longAgo }));
    const swapped = await post(
      served.url,
      signedEnvelope(ordersKeys),
      JSON.stringify({ input: { text: "pay" } }),
    );

    expect([forged.status, expired.status, swapped.status]).toEqual([401, 401, 401]);
    expect(await forged.json()).toMatchObject({ code: "mesh.signature-invalid" });
    expect(await expired.json()).toMatchObject({ code: "mesh.envelope-expired" });
    expect(await swapped.json()).toMatchObject({ code: "mesh.body-mismatch" });
    expect(started.parts.seen).toHaveLength(1); // only the body mismatch reached the resolver
    expect(book.scriptOf("agent:billing-desk-agent").requests).toHaveLength(0);
  });
});

describe("#398 PR 2: a trusted request is deduplicated by its idempotency key", () => {
  it("the same request twice: one run, the same answer", async () => {
    const [ordersKeys, billingKeys] = [meshKeyPair(), meshKeyPair()];
    const book = new ScriptBook();
    const { served } = await billing(ordersKeys, billingKeys, book);
    book.scriptOf("agent:billing-desk-agent").thenReturn(replyWith("Invoice 7 is paid."));
    const mesh = signedEnvelope(ordersKeys);

    const first: unknown = await (await post(served.url, mesh)).json();
    const second: unknown = await (await post(served.url, mesh)).json();

    expect(second).toEqual(first);
    expect(first).toMatchObject({ status: A2AStatus.Finished, report: expect.any(String) });
    expect(book.scriptOf("agent:billing-desk-agent").requests).toHaveLength(1);
  });
});

describe("#398 PR 2: meshVerifier", () => {
  it("a listener's verifier gives the peer's key: the request is trusted without mesh.peers", async () => {
    const ordersKeys = meshKeyPair();
    const book = new ScriptBook();
    const served = await endpoint(open);
    const Verifier = meshVerifierOf({ "orders-application": ordersKeys.publicPem });
    const started = await meshApp(
      open,
      served,
      {
        name: "billing",
        peerUrl: "http://unused",
        peer: "orders-application",
        providers: [Verifier],
      },
      book,
      { meshVerifier: Verifier },
    );
    book.scriptOf("agent:billing-desk-agent").thenReturn(replyWith("ok"));

    await post(served.url, signedEnvelope(ordersKeys));
    const forged = await post(served.url, signedEnvelope(meshKeyPair(), {}, "k-2"));

    expect(started.parts.started[0]?.origin?.application).toBe("orders-application");
    expect(forged.status).toBe(401);
  });
});

describe("#398 PR 2: POST /cancel", () => {
  it("A2AClient.cancel of an unknown thread fails with the receiver's code", async () => {
    const served = await endpoint(open);
    await meshApp(open, served, { name: "billing", peerUrl: "http://unused" }, new ScriptBook());

    const cancelled = new A2AClient({ url: served.url }).cancel("no-such-thread");

    await expect(cancelled).rejects.toThrow(/thread/i);
  });
});
