import { afterEach, describe, expect, it } from "vitest";
import { encodeMeshEnvelope } from "../../src/mesh/mesh-envelope-codec.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { usd, type Usd } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { closeAll, endpoint, meshApp, opened } from "./fixtures/endpoints.js";
import { meshEnvOf, meshKeyPair, meshOf } from "./fixtures/mesh-keys.js";

const open = opened();

afterEach(() => closeAll(open));

/** The envelope of a request header, decoded. */
const envelopeOf = (header: string | string[] | undefined): unknown =>
  JSON.parse(Buffer.from(String(header).split(".")[1] ?? "", "base64url").toString("utf8"));

/** What one orders → billing call is made with: trust, the contract price, the peer it names. */
interface CallSpec {
  readonly isTrusted: boolean;
  readonly price?: Usd;
  readonly peerName?: string;
  readonly billingCost?: Usd;
}

/** orders-application calls billing-application once over A2A, through its peer agent. */
async function ordersCallsBilling(spec: CallSpec) {
  const [ordersKeys, billingKeys] = [meshKeyPair(), meshKeyPair()];
  const [ordersBook, billingBook] = [new ScriptBook(), new ScriptBook()];
  const billingAt = await endpoint(open);
  const trust = (peer: string) => (spec.isTrusted ? { mesh: meshOf(peer) } : {});
  await meshApp(
    open,
    billingAt,
    {
      name: "billing",
      peerUrl: "http://unused",
      ...trust("orders-application"),
      ...(spec.isTrusted ? { peer: "orders-application" } : {}),
    },
    billingBook,
    { processEnv: spec.isTrusted ? meshEnvOf(billingKeys, ordersKeys) : {} },
  );
  const ordersAt = await endpoint(open);
  const local = await meshApp(
    open,
    ordersAt,
    {
      name: "orders",
      peerUrl: billingAt.url,
      peerName: spec.peerName ?? "billing",
      ...trust("billing-application"),
      ...(spec.price === undefined ? {} : { price: spec.price }),
    },
    ordersBook,
    { processEnv: spec.isTrusted ? meshEnvOf(ordersKeys, billingKeys) : {} },
  );
  ordersBook
    .scriptOf("agent:orders-desk-agent")
    .thenReturn(callTool(local.parts.CallPeer, { question: "invoice 7?" }), replyWith("Paid."));
  billingBook
    .scriptOf("agent:billing-desk-agent")
    .thenReturn(replyWith("Invoice 7 is paid.", { cost: spec.billingCost ?? usd(0) }));
  const run = execute(local.app, local.parts.MeshStart, { text: "is invoice 7 paid?" });
  return { run, billingAt, billingBook };
}

describe("#398 PR 3: the envelope's audience is the client's target", () => {
  it("A2AClient addresses the envelope to its target application", async () => {
    const { run, billingAt } = await ordersCallsBilling({ isTrusted: false });

    await run;

    expect(envelopeOf(billingAt.headers[0]?.["agboss-mesh"])).toMatchObject({
      issuer: "orders-application",
      audience: "billing-application",
    });
  });

  it("an envelope meant for another application is refused: 401 mesh.audience-mismatch", async () => {
    const { run, billingBook } = await ordersCallsBilling({
      isTrusted: false,
      peerName: "invoices", // the client names another application than the one it reaches
    });

    const result = await run; // the tool's failure goes to the model, which answers

    expect(result.toolCalls[0]?.error?.message).toMatch(/^\[mesh\.audience-mismatch\]/);
    expect(billingBook.scriptOf("agent:billing-desk-agent").requests).toHaveLength(0);
  });

  it("the refusal comes before the resolver, signed or not", async () => {
    const billingAt = await endpoint(open);
    const billing = await meshApp(
      open,
      billingAt,
      { name: "billing", peerUrl: "http://unused" },
      new ScriptBook(),
    );
    const misaddressed = encodeMeshEnvelope({
      schema: 1,
      issuer: "orders-application",
      audience: "invoices-application",
      origin: {
        rootExecutionId: "r",
        executionId: "r",
        workflow: { name: "orders-workflow", version: "1.0.0" },
        step: { component: "orders-desk-agent", idempotencyKey: "r:1" },
      },
      callChain: [],
    });

    const response = await fetch(`${billingAt.url}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", "agboss-mesh": misaddressed },
      body: JSON.stringify({ input: { text: "hi" } }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "mesh.audience-mismatch" });
    expect(billing.parts.seen).toHaveLength(0);
  });
});

describe("#398 PR 3: the contract price (Q6 c) — the larger of it and the verified report", () => {
  it("an untrusted peer: the price alone, no remote execution", async () => {
    const { run } = await ordersCallsBilling({ isTrusted: false, price: usd(0.1) });

    const result = await run;

    expect(result.spend.byModel["a2a:billing-application"]).toBeCloseTo(0.1);
    expect(result.toolCalls[0]?.remote).toBeUndefined();
  });

  it("a trusted peer reporting more than the price: its report", async () => {
    const { run } = await ordersCallsBilling({
      isTrusted: true,
      price: usd(0.1),
      billingCost: usd(0.25),
    });

    const result = await run;

    expect(result.spend.byModel["a2a:billing-application"]).toBeCloseTo(0.25);
    expect(result.toolCalls[0]?.remote?.application).toBe("billing-application");
  });

  it("a trusted peer reporting less than the price: the price", async () => {
    const { run } = await ordersCallsBilling({
      isTrusted: true,
      price: usd(0.5),
      billingCost: usd(0.25),
    });

    const result = await run;

    expect(result.spend.byModel["a2a:billing-application"]).toBeCloseTo(0.5);
  });
});
