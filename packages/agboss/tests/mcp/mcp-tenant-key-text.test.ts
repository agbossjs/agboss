/**
 * #552 acceptance, #568 — a trusted MCP call is deduplicated by (tenant, peer, callId) in
 * `MeshRequestRepository`, before its execution checks the session's tenant id. A tenant id that is
 * no key's text keys no kept result: on a UTF-8 store `t\uD800` is `t�`, so its refusal would be
 * kept as `t�`'s answer (or `t�`'s answer handed to it). Each such call runs and is refused
 * by its execution, nothing kept; the A2A key (`dedupeKeyOf`) is the same rule.
 */
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { dedupeKeyOf, type TrustedRequest } from "../../src/a2a/a2a-trusted.js";
import { createApp } from "../../src/application/create-app.js";
import type { App } from "../../src/app/types.js";
import { MeshRequestRepository } from "../../src/infrastructure/mesh-request.repository.js";
import { createMcpService, McpExpose } from "../../src/mcp/index.js";
import { encodeMeshEnvelope } from "../../src/mesh/mesh-envelope-codec.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { offline } from "../a2a/fixtures/remote.workflow.js";
import { meshAppOf } from "../a2a/fixtures/mesh.workflow.js";
import { meshEnvOf, meshKeyPair, meshOf, type MeshKeyPair } from "../a2a/fixtures/mesh-keys.js";

const apps: App[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const args = { text: "is invoice 7 paid?" };
const CALL_ID = "root-1:orders-desk-agent:1:c1";

/** An envelope orders-application signs for `args`, with budget to run. */
const funded = (key: MeshKeyPair): string =>
  encodeMeshEnvelope(
    {
      schema: 1,
      issuer: "orders-application",
      origin: {
        rootExecutionId: "root-1",
        executionId: "root-1",
        workflow: { name: "orders-workflow", version: "1.0.0" },
        step: { component: "orders-desk-agent", idempotencyKey: CALL_ID },
      },
      callChain: [],
      issuedAt: new Date().toISOString(),
      expiresIn: "PT60S",
      bodyHash: `sha256:${createHash("sha256").update(JSON.stringify(args)).digest("hex")}`,
      budget: { remaining: "1", currency: "USD" },
    },
    key.privateKey,
  );

/** billing-application over MCP, its session authenticated as orders-application for `tenantId`. */
async function billing(tenantId: string) {
  const [orders, own] = [meshKeyPair(), meshKeyPair()];
  const parts = meshAppOf({
    name: "billing",
    peerUrl: "http://unused",
    mesh: meshOf("orders-application"),
  });
  @McpExpose({ name: "billing-mcp", version: "1.0.0", exports: [parts.MeshStart] })
  class BillingMcp {}
  const book = new ScriptBook();
  const app = await createApp(parts.MeshApplication, {
    ...offline(book),
    env: "signing",
    processEnv: meshEnvOf(own, orders),
  });
  apps.push(app);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpService(app, BillingMcp).connect(serverSide, {
    peer: "orders-application",
    tenant: { tenantId },
  });
  const client = new Client({ name: "orders", version: "1.0.0" });
  await client.connect(clientSide);
  return { app, client, book, orders };
}

describe("#568: a trusted MCP call under a tenant id that is no key's text", () => {
  it.each([
    ["a lone high surrogate", "t\uD800"],
    ["NFD", "cafe\u0301"],
    ["a trailing space", "acme "],
  ])(
    "%s: refused by its execution each time, no result kept under it",
    async (_label, tenantId) => {
      const { app, client, book, orders } = await billing(tenantId);
      const call = {
        name: "billing-workflow-start",
        arguments: args,
        _meta: { "agboss.dev/mesh": funded(orders), callId: CALL_ID },
      };

      const first = await client.callTool(call);
      const second = await client.callTool(call);

      for (const answer of [first, second]) {
        expect(answer.isError).toBe(true);
        expect(JSON.stringify(answer.content)).toContain("tenantId");
      }
      expect(book.scriptOf("agent:billing-desk-agent").requests).toHaveLength(0);
      const kept = await app
        .resolve(MeshRequestRepository)
        .findByKey({ tenantId, peer: "orders-application", idempotencyKey: CALL_ID });
      expect(kept).toBeUndefined();
    },
  );
});

describe("#568: the A2A answer's key", () => {
  const trusted = (tenantId: string): TrustedRequest => ({
    tenantId,
    peer: "orders-application",
    envelope: {
      schema: 1,
      issuer: "orders-application",
      origin: {
        rootExecutionId: "root-1",
        executionId: "root-1",
        workflow: { name: "orders-workflow", version: "1.0.0" },
        step: { component: "orders-desk-agent", idempotencyKey: CALL_ID },
      },
      callChain: [],
    },
  });

  it("is none for a tenant id that is no key's text, and the request's own for one that is", () => {
    for (const tenantId of ["t\uD800", "t\uDFFF", "cafe\u0301", "acme​", " acme"])
      expect(dedupeKeyOf(trusted(tenantId)), tenantId).toBeUndefined();
    expect(dedupeKeyOf(trusted("t�"))).toEqual({
      tenantId: "t�",
      peer: "orders-application",
      idempotencyKey: CALL_ID,
    });
  });
});
