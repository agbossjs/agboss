import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { a2aHttpListener, A2AClient, A2AStatus } from "../../src/a2a/index.js";
import { createApp } from "../../src/application/create-app.js";
import type { App } from "../../src/app/types.js";
import { HopsLimitExceededError, MeshLoopDetectedError } from "../../src/index.js";
import { encodeMeshEnvelope } from "../../src/mesh/mesh-envelope-codec.js";
import type { MeshEnvelope } from "../../src/mesh/mesh-envelope.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { execute } from "../helpers/flow.js";
import { offline } from "./fixtures/remote.workflow.js";
import { meshAppOf, type MeshAppParts, type MeshAppSpec } from "./fixtures/mesh.workflow.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** A server listening before its application exists, so two applications can name each other. */
interface Endpoint {
  readonly url: string;
  /** Every request's headers, in order. */
  readonly headers: IncomingMessage["headers"][];
  serve(handler: Handler): void;
}

const servers: Server[] = [];
const apps: App[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

async function endpoint(): Promise<Endpoint> {
  let current: Handler | undefined;
  const headers: IncomingMessage["headers"][] = [];
  const server = createServer((req, res) => {
    headers.push(req.headers);
    current?.(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    headers,
    serve: (handler) => {
      current = handler;
    },
  };
}

/** One mesh application, served at `own`, calling `spec.peerUrl`. */
async function meshApp(
  own: Endpoint,
  spec: MeshAppSpec,
  book: ScriptBook,
): Promise<{ readonly app: App; readonly parts: MeshAppParts }> {
  const parts = meshAppOf(spec);
  const app = await createApp(parts.MeshApplication, offline(book));
  apps.push(app);
  own.serve(a2aHttpListener(app, { start: parts.MeshStart, callerResolver: parts.Resolver }));
  return { app, parts };
}

/** The envelope of a request header, decoded. */
const envelopeOf = (header: string | string[] | undefined): unknown =>
  JSON.parse(Buffer.from(String(header).split(".")[1] ?? "", "base64url").toString("utf8"));

/** An envelope a caller claims: its chain only matters here. */
const claimed = (callChain: MeshEnvelope["callChain"]): string =>
  encodeMeshEnvelope({
    schema: 1,
    issuer: "elsewhere-application",
    origin: {
      rootExecutionId: "root-1",
      executionId: "root-1",
      workflow: { name: "elsewhere-workflow", version: "1.0.0" },
      step: { component: "ask-tool", idempotencyKey: "root-1:ask-agent:1:call_1" },
    },
    callChain,
  });

describe("#398 PR 1: a call made inside an execution carries the mesh envelope", () => {
  it("A2AClient sends agboss-mesh (the chain ends with the caller's own hop) and a traceparent", async () => {
    const [orders, billing] = [await endpoint(), await endpoint()];
    const ordersBook = new ScriptBook();
    const billingBook = new ScriptBook();
    const remote = await meshApp(billing, { name: "billing", peerUrl: orders.url }, billingBook);
    const local = await meshApp(orders, { name: "orders", peerUrl: billing.url }, ordersBook);
    ordersBook
      .scriptOf("agent:orders-desk-agent")
      .thenReturn(callTool(local.parts.CallPeer, { question: "invoice 7?" }), replyWith("Paid."));
    billingBook.scriptOf("agent:billing-desk-agent").thenReturn(replyWith("Invoice 7 is paid."));

    const result = await execute(local.app, local.parts.MeshStart, { text: "is invoice 7 paid?" });

    const [sent] = billing.headers;
    expect(result).toMatchObject({ output: { text: "Paid." } });
    expect(envelopeOf(sent?.["agboss-mesh"])).toMatchObject({
      schema: 1,
      issuer: "orders-application",
      origin: {
        rootExecutionId: result.executionId,
        executionId: result.executionId,
        workflow: { name: "orders-workflow" },
        step: { component: "orders-desk-agent" }, // the step; its key ends with the call id
      },
      callChain: [
        {
          application: "orders-application",
          start: "orders-workflow-start",
          executionId: result.executionId,
        },
      ],
    });
    expect(sent?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(remote.parts.seen[0]?.envelope?.issuer).toBe("orders-application");
  });

  it("the receiver continues the caller's trace and carries its chain on", async () => {
    const [first, second, third] = [await endpoint(), await endpoint(), await endpoint()];
    const [bookA, bookB, bookC] = [new ScriptBook(), new ScriptBook(), new ScriptBook()];
    const a = await meshApp(first, { name: "a", peerUrl: second.url }, bookA);
    const b = await meshApp(second, { name: "b", peerUrl: third.url }, bookB);
    await meshApp(third, { name: "c", peerUrl: first.url }, bookC);
    bookA
      .scriptOf("agent:a-desk-agent")
      .thenReturn(callTool(a.parts.CallPeer, { question: "q" }), replyWith("done"));
    bookB
      .scriptOf("agent:b-desk-agent")
      .thenReturn(callTool(b.parts.CallPeer, { question: "q" }), replyWith("b done"));
    bookC.scriptOf("agent:c-desk-agent").thenReturn(replyWith("c done"));

    await execute(a.app, a.parts.MeshStart, { text: "go" });

    const [toB] = second.headers;
    const [toC] = third.headers;
    const traceOf = (header: string | string[] | undefined): string => String(header).slice(3, 35);
    expect(traceOf(toC?.traceparent)).toBe(traceOf(toB?.traceparent));
    expect(envelopeOf(toC?.["agboss-mesh"])).toMatchObject({
      issuer: "b-application",
      callChain: [
        { application: "a-application", start: "a-workflow-start" },
        { application: "b-application", start: "b-workflow-start" },
      ],
    });
  });

  it("outside an execution A2AClient sends no envelope", async () => {
    const orders = await endpoint();
    const book = new ScriptBook();
    const local = await meshApp(orders, { name: "orders", peerUrl: "http://unused" }, book);
    book.scriptOf("agent:orders-desk-agent").thenReturn(replyWith("hi"));

    await new A2AClient({ url: orders.url }).send({ text: "hi" });

    expect(orders.headers[0]?.["agboss-mesh"]).toBeUndefined();
    expect(local.parts.seen[0]?.envelope).toBeUndefined();
  });
});

describe("#398 PR 1: a loop through the mesh is refused deterministically", () => {
  it("A → B → A: A refuses B's call before it runs, and A's own step fails with the loop", async () => {
    const [first, second] = [await endpoint(), await endpoint()];
    const [bookA, bookB] = [new ScriptBook(), new ScriptBook()];
    const a = await meshApp(first, { name: "a", peerUrl: second.url }, bookA);
    const b = await meshApp(second, { name: "b", peerUrl: first.url }, bookB);
    bookA.scriptOf("agent:a-desk-agent").thenReturn(callTool(a.parts.CallPeer, { question: "q" }));
    bookB.scriptOf("agent:b-desk-agent").thenReturn(callTool(b.parts.CallPeer, { question: "q" }));

    const run = execute(a.app, a.parts.MeshStart, { text: "go" });

    await expect(run).rejects.toFailWith(MeshLoopDetectedError, {
      code: "limit.mesh-loop",
      entry: { application: "a-application", start: "a-workflow-start" },
      chain: [
        expect.objectContaining({ application: "a-application" }),
        expect.objectContaining({ application: "b-application" }),
      ],
    });
    expect(bookA.scriptOf("agent:a-desk-agent").requests).toHaveLength(1); // the model never read it
    expect(bookB.scriptOf("agent:b-desk-agent").requests).toHaveLength(1);
    expect(a.parts.seen).toHaveLength(1); // B's call: refused after its caller was resolved
  });

  it(".onError(MeshLoopDetectedError, …) takes the loop on the caller's path", async () => {
    const [first, second] = [await endpoint(), await endpoint()];
    const [bookA, bookB] = [new ScriptBook(), new ScriptBook()];
    const spec = { name: "a", peerUrl: second.url, handlesLoop: true };
    const a = await meshApp(first, spec, bookA);
    const b = await meshApp(second, { name: "b", peerUrl: first.url }, bookB);
    bookA.scriptOf("agent:a-desk-agent").thenReturn(callTool(a.parts.CallPeer, { question: "q" }));
    bookB.scriptOf("agent:b-desk-agent").thenReturn(callTool(b.parts.CallPeer, { question: "q" }));

    const result = await execute(a.app, a.parts.MeshStart, { text: "go" });

    expect(result).toFinishWith(a.parts.LoopFinish, { text: "go" });
  });

  it("the refusal is a 409 with the limit's code and facts; nothing runs", async () => {
    const orders = await endpoint();
    const book = new ScriptBook();
    const local = await meshApp(orders, { name: "orders", peerUrl: "http://unused" }, book);
    const chain = [
      { application: "orders-application", start: "orders-workflow-start", executionId: "x-1" },
      { application: "billing-application", start: "billing-workflow-start", executionId: "y-1" },
    ];

    const response = await fetch(`${orders.url}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", "agboss-mesh": claimed(chain) },
      body: JSON.stringify({ input: { text: "hi" } }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "limit.mesh-loop",
      error: expect.stringContaining("orders-application › orders-workflow-start"),
      details: { entry: { application: "orders-application" }, chain },
    });
    expect(book.scriptOf("agent:orders-desk-agent").requests).toHaveLength(0);
    expect(local.parts.seen[0]?.envelope?.callChain).toEqual(chain);
  });

  it("A2AClient.send rethrows a 409 as the typed limit", async () => {
    const orders = await endpoint();
    await meshApp(orders, { name: "orders", peerUrl: "http://unused" }, new ScriptBook());
    const chain = [
      { application: "orders-application", start: "orders-workflow-start", executionId: "x" },
    ];
    const headers = { "agboss-mesh": claimed(chain) };

    const sent = new A2AClient({ url: orders.url, headers }).send({ text: "hi" });

    await expect(sent).rejects.toFailWith(MeshLoopDetectedError, { chain });
  });
});

describe("#398 PR 1: maxMeshHops", () => {
  it("a chain as long as the receiver's maxMeshHops is refused, and the caller's step fails", async () => {
    const [first, second] = [await endpoint(), await endpoint()];
    const [bookA, bookB] = [new ScriptBook(), new ScriptBook()];
    const a = await meshApp(first, { name: "a", peerUrl: second.url }, bookA);
    await meshApp(second, { name: "b", peerUrl: first.url, maxMeshHops: 1 }, bookB);
    bookA.scriptOf("agent:a-desk-agent").thenReturn(callTool(a.parts.CallPeer, { question: "q" }));

    const run = execute(a.app, a.parts.MeshStart, { text: "go" });

    await expect(run).rejects.toFailWith(HopsLimitExceededError, {
      code: "limit.hops",
      maxMeshHops: 1,
      hops: 2,
      entry: { application: "b-application", start: "b-workflow-start" },
    });
    expect(bookB.scriptOf("agent:b-desk-agent").requests).toHaveLength(0);
  });

  it("the default allows a chain of 7 applications before the receiver", async () => {
    const orders = await endpoint();
    const book = new ScriptBook();
    await meshApp(orders, { name: "orders", peerUrl: "http://unused" }, book);
    book.scriptOf("agent:orders-desk-agent").thenReturn(replyWith("ok"));
    const hop = (index: number) => ({
      application: `app-${String(index)}-application`,
      start: "s-workflow-start",
      executionId: `e-${String(index)}`,
    });
    const seven = [0, 1, 2, 3, 4, 5, 6].map(hop);
    const eight = [...seven, hop(7)];

    const admitted = await new A2AClient({
      url: orders.url,
      headers: { "agboss-mesh": claimed(seven) },
    }).send({ text: "hi" });
    const refused = new A2AClient({
      url: orders.url,
      headers: { "agboss-mesh": claimed(eight) },
    }).send({ text: "hi" });

    expect(admitted.status).toBe(A2AStatus.Finished);
    await expect(refused).rejects.toFailWith(HopsLimitExceededError, { maxMeshHops: 8, hops: 9 });
  });
});

describe("#398 PR 1: the envelope is a claim", () => {
  it("a malformed envelope is ignored: the request runs as one without", async () => {
    const orders = await endpoint();
    const book = new ScriptBook();
    const local = await meshApp(orders, { name: "orders", peerUrl: "http://unused" }, book);
    book.scriptOf("agent:orders-desk-agent").thenReturn(replyWith("ok"));
    const signed = claimed([]).replace(/\.$/, ".c2lnbmF0dXJl"); // not an unsecured JWS of PR 1

    const response = await new A2AClient({
      url: orders.url,
      headers: { "agboss-mesh": signed, traceparent: "not a trace" },
    }).send({ text: "hi" });

    expect(response.status).toBe(A2AStatus.Finished);
    expect(local.parts.seen[0]?.envelope).toBeUndefined();
  });
});
