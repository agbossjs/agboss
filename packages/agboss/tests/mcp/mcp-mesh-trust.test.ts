import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/application/create-app.js";
import type { App } from "../../src/app/types.js";
import { createMcpService, McpExpose } from "../../src/mcp/index.js";
import { encodeMeshEnvelope } from "../../src/mesh/mesh-envelope-codec.js";
import { readJws } from "../../src/mesh/mesh-jws.js";
import { replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { offline } from "../a2a/fixtures/remote.workflow.js";
import { meshAppOf } from "../a2a/fixtures/mesh.workflow.js";
import { meshEnvOf, meshKeyPair, meshOf, type MeshKeyPair } from "../a2a/fixtures/mesh-keys.js";

const apps: App[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const args = { text: "is invoice 7 paid?" };

/** An envelope orders-application signs for `args`, issued now. */
const signed = (key: MeshKeyPair, body: unknown = args): string =>
  encodeMeshEnvelope(
    {
      schema: 1,
      issuer: "orders-application",
      origin: {
        rootExecutionId: "root-1",
        executionId: "root-1",
        workflow: { name: "orders-workflow", version: "1.0.0" },
        step: { component: "orders-desk-agent", idempotencyKey: "root-1:orders-desk-agent:1:c1" },
      },
      callChain: [],
      issuedAt: new Date().toISOString(),
      expiresIn: "PT60S",
      bodyHash: `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`,
      budget: { remaining: "0", currency: "USD" },
    },
    key.privateKey,
  );

/** billing-application over MCP; its session's transport authenticated orders-application. */
async function billing(book: ScriptBook, orders: MeshKeyPair, own: MeshKeyPair) {
  const parts = meshAppOf({
    name: "billing",
    peerUrl: "http://unused",
    mesh: meshOf("orders-application"),
  });
  @McpExpose({ name: "billing-mcp", version: "1.0.0", exports: [parts.MeshStart] })
  class BillingMcp {}
  const app = await createApp(parts.MeshApplication, {
    ...offline(book),
    env: "signing",
    processEnv: meshEnvOf(own, orders),
  });
  apps.push(app);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpService(app, BillingMcp).connect(serverSide, { peer: "orders-application" });
  const client = new Client({ name: "orders", version: "1.0.0" });
  await client.connect(clientSide);
  return { client, parts };
}

/** An envelope orders-application signs for `args`, with budget left to run. */
const funded = (key: MeshKeyPair): string =>
  encodeMeshEnvelope(
    {
      ...(readJws(signed(key))?.payload as Parameters<typeof encodeMeshEnvelope>[0]),
      budget: { remaining: "1", currency: "USD" },
    },
    key.privateKey,
  );

describe("#398 PR 2: a trusted peer's MCP call", () => {
  it("runs on the caller's budget: nothing left, nothing runs", async () => {
    const [ordersKeys, billingKeys] = [meshKeyPair(), meshKeyPair()];
    const book = new ScriptBook();
    const { client } = await billing(book, ordersKeys, billingKeys);

    const result = await client.callTool({
      name: "billing-workflow-start",
      arguments: args,
      _meta: { "agboss.dev/mesh": signed(ordersKeys) },
    });

    expect(result.isError).toBe(true); // the caller had nothing left: caller-budget
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("caller-budget allows $0") },
    ]);
    expect(book.scriptOf("agent:billing-desk-agent").requests).toHaveLength(0);
  });

  it("a finished call's _meta carries the report, signed by the receiver", async () => {
    const [ordersKeys, billingKeys] = [meshKeyPair(), meshKeyPair()];
    const book = new ScriptBook();
    const { client } = await billing(book, ordersKeys, billingKeys);
    book.scriptOf("agent:billing-desk-agent").thenReturn(replyWith("paid"));
    const envelope = funded(ordersKeys);

    const result = await client.callTool({
      name: "billing-workflow-start",
      arguments: args,
      _meta: { "agboss.dev/mesh": envelope },
    });

    const report = readJws(result._meta?.["agboss.dev/report"]);
    expect(result.isError).toBeFalsy();
    expect(report?.payload).toMatchObject({ issuer: "billing-application" });
    expect(report?.signed).toBeDefined();
  });

  it("another key's signature or another body is refused before anything runs", async () => {
    const [ordersKeys, billingKeys] = [meshKeyPair(), meshKeyPair()];
    const book = new ScriptBook();
    const { client } = await billing(book, ordersKeys, billingKeys);

    const forged = await client.callTool({
      name: "billing-workflow-start",
      arguments: args,
      _meta: { "agboss.dev/mesh": signed(meshKeyPair()) },
    });
    const swapped = await client.callTool({
      name: "billing-workflow-start",
      arguments: { text: "pay everything" },
      _meta: { "agboss.dev/mesh": signed(ordersKeys) },
    });

    expect(forged._meta?.["agboss.dev/error"]).toMatchObject({ code: "mesh.signature-invalid" });
    expect(swapped._meta?.["agboss.dev/error"]).toMatchObject({ code: "mesh.body-mismatch" });
    expect(book.scriptOf("agent:billing-desk-agent").requests).toHaveLength(0);
  });
});

describe("#398 PR 2b: a trusted MCP call is deduplicated by _meta.callId", () => {
  it("the same call twice: one run, the kept result", async () => {
    const [ordersKeys, billingKeys] = [meshKeyPair(), meshKeyPair()];
    const book = new ScriptBook();
    const { client } = await billing(book, ordersKeys, billingKeys);
    book.scriptOf("agent:billing-desk-agent").thenReturn(replyWith("paid"));
    const call = {
      name: "billing-workflow-start",
      arguments: args,
      _meta: { "agboss.dev/mesh": funded(ordersKeys), callId: "root-1:orders-desk-agent:1:c1" },
    };

    const first = await client.callTool(call);
    const second = await client.callTool(call);

    expect(first.isError).toBeFalsy();
    expect(second).toEqual(first);
    expect(book.scriptOf("agent:billing-desk-agent").requests).toHaveLength(1);
  });

  it("a repeat while the first still runs: mesh.request-in-progress, nothing runs twice", async () => {
    const [ordersKeys, billingKeys] = [meshKeyPair(), meshKeyPair()];
    const book = new ScriptBook();
    const { client } = await billing(book, ordersKeys, billingKeys);
    book.scriptOf("agent:billing-desk-agent").thenReturn(replyWith("paid"));
    const call = {
      name: "billing-workflow-start",
      arguments: args,
      _meta: { "agboss.dev/mesh": funded(ordersKeys), callId: "c-2" },
    };

    const [first, second] = await Promise.all([client.callTool(call), client.callTool(call)]);

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBe(true);
    expect(second._meta?.["agboss.dev/error"]).toMatchObject({ code: "mesh.request-in-progress" });
    expect(book.scriptOf("agent:billing-desk-agent").requests).toHaveLength(1);
  });

  it("another call id, or an untrusted call, runs again", async () => {
    const [ordersKeys, billingKeys] = [meshKeyPair(), meshKeyPair()];
    const book = new ScriptBook();
    const { client } = await billing(book, ordersKeys, billingKeys);
    book
      .scriptOf("agent:billing-desk-agent")
      .thenReturn(replyWith("one"), replyWith("two"), replyWith("three"), replyWith("four"));
    const callOf = (callId: string, mesh: string | undefined) => ({
      name: "billing-workflow-start",
      arguments: args,
      _meta: { ...(mesh === undefined ? {} : { "agboss.dev/mesh": mesh }), callId },
    });

    await client.callTool(callOf("c-3", funded(ordersKeys)));
    await client.callTool(callOf("c-4", funded(ordersKeys)));
    await client.callTool(callOf("c-5", undefined));
    await client.callTool(callOf("c-5", undefined));

    expect(book.scriptOf("agent:billing-desk-agent").requests).toHaveLength(4);
  });
});

describe("#398 PR 3: an MCP call meant for another application", () => {
  it("is refused before anything runs: mesh.audience-mismatch", async () => {
    const [ordersKeys, billingKeys] = [meshKeyPair(), meshKeyPair()];
    const book = new ScriptBook();
    const { client } = await billing(book, ordersKeys, billingKeys);
    const misaddressed = encodeMeshEnvelope({
      ...(readJws(funded(ordersKeys))?.payload as Parameters<typeof encodeMeshEnvelope>[0]),
      audience: "invoices-application",
    });

    const result = await client.callTool({
      name: "billing-workflow-start",
      arguments: args,
      _meta: { "agboss.dev/mesh": misaddressed },
    });

    expect(result._meta?.["agboss.dev/error"]).toMatchObject({ code: "mesh.audience-mismatch" });
    expect(book.scriptOf("agent:billing-desk-agent").requests).toHaveLength(0);
  });
});
