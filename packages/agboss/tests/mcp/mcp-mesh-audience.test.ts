import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createAppWith } from "../../src/application/create-app.js";
import type { App } from "../../src/app/types.js";
import { createMcpService, McpExpose } from "../../src/mcp/index.js";
import { admitMcpCall } from "../../src/mcp/mcp-mesh-gate.js";
import { encodeMeshEnvelope, readMeshEnvelope } from "../../src/mesh/mesh-envelope-codec.js";
import type { MeshEnvelope } from "../../src/mesh/mesh-envelope.js";
import { meshSettingsOf } from "../../src/mesh/mesh-settings.js";
import { audienceRefusalOf } from "../../src/mesh/mesh-verification.js";
import { replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { offline } from "../a2a/fixtures/remote.workflow.js";
import { meshAppOf } from "../a2a/fixtures/mesh.workflow.js";
import { meshKeyPair } from "../a2a/fixtures/mesh-keys.js";

/**
 * #961 (from #808/#809): an MCP server checks the envelope's audience exactly as the A2A server
 * does — against the application's own name, whoever signed it — for every app `createApp` or
 * `testWith` builds, with or without `mesh` keys (every such app has mesh settings: its name, its
 * keys, possibly none). The one app the check skips is a hand-built `App` with no mesh settings at
 * all: it has no name an envelope could be addressed to (the A2A listener refuses to serve it:
 * `a2a.app-required`; an MCP server of it stays a plain tool server, as before #398).
 */

const apps: App[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const claims: MeshEnvelope = {
  schema: 1,
  issuer: "orders-application",
  origin: {
    rootExecutionId: "root-1",
    executionId: "root-1",
    workflow: { name: "orders-workflow", version: "1.0.0" },
    step: { component: "orders-desk-agent", idempotencyKey: "root-1:orders-desk-agent:1:c1" },
  },
  callChain: [],
  issuedAt: "2026-01-05T09:00:00.000Z",
  expiresIn: "PT60S",
  bodyHash: "sha256:00",
  budget: { remaining: "1", currency: "USD" },
};

/** An envelope naming `audience` (`undefined`: none), signed by a key nobody trusts or not at all. */
const envelopeOf = (audience: string | undefined, isSigned: boolean): string =>
  encodeMeshEnvelope(
    audience === undefined ? claims : { ...claims, audience },
    isSigned ? meshKeyPair().privateKey : undefined,
  );

const text = { text: "is invoice 7 paid?" };

/** billing-application over MCP with no `mesh` option: no keys, no peers — and still its name. */
async function keylessBilling(book: ScriptBook) {
  const parts = meshAppOf({ name: "billing", peerUrl: "http://unused" });
  @McpExpose({ name: "billing-mcp", version: "1.0.0", exports: [parts.MeshStart] })
  class BillingMcp {}
  const app = await createAppWith(parts.MeshApplication, offline(book));
  apps.push(app);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpService(app, BillingMcp).connect(serverSide);
  const client = new Client({ name: "orders", version: "1.0.0" });
  await client.connect(clientSide);
  return { app, client };
}

describe("#961: an MCP server of an app with no mesh keys checks the audience, as A2A does", () => {
  it("an envelope naming another application is mesh.audience-mismatch, signed or not", async () => {
    for (const isSigned of [false, true]) {
      const book = new ScriptBook();
      const { client } = await keylessBilling(book);

      const result = await client.callTool({
        name: "billing-workflow-start",
        arguments: text,
        _meta: { "agboss.dev/mesh": envelopeOf("invoices-application", isSigned) },
      });

      expect(result.isError).toBe(true);
      expect(result._meta?.["agboss.dev/error"]).toMatchObject({ code: "mesh.audience-mismatch" });
      expect(book.scriptOf("agent:billing-desk-agent").requests).toHaveLength(0);
    }
  });

  it("a signed envelope naming no audience is mesh.audience-missing: a forged one too", async () => {
    const book = new ScriptBook();
    const { client } = await keylessBilling(book);

    const result = await client.callTool({
      name: "billing-workflow-start",
      arguments: text,
      _meta: { "agboss.dev/mesh": envelopeOf(undefined, true) },
    });

    expect(result._meta?.["agboss.dev/error"]).toMatchObject({ code: "mesh.audience-missing" });
    expect(book.scriptOf("agent:billing-desk-agent").requests).toHaveLength(0);
  });

  it("one addressed to it, or an unsigned claim naming none, runs", async () => {
    for (const meta of [envelopeOf("billing-application", false), envelopeOf(undefined, false)]) {
      const book = new ScriptBook();
      book.scriptOf("agent:billing-desk-agent").thenReturn(replyWith("paid"));
      const { client } = await keylessBilling(book);

      const result = await client.callTool({
        name: "billing-workflow-start",
        arguments: text,
        _meta: { "agboss.dev/mesh": meta },
      });

      expect(result.isError).not.toBe(true);
      expect(book.scriptOf("agent:billing-desk-agent").requests).toHaveLength(1);
    }
  });

  it("the gate's verdict is the shared check's, envelope by envelope", async () => {
    const { app } = await keylessBilling(new ScriptBook());
    const application = meshSettingsOf(app)?.application;
    expect(application).toBe("billing-application");
    for (const [audience, isSigned] of [
      ["billing-application", true],
      ["billing-application", false],
      ["invoices-application", true],
      ["invoices-application", false],
      [undefined, true],
      [undefined, false],
    ] as const) {
      const meta = envelopeOf(audience, isSigned);
      const expected = audienceRefusalOf(readMeshEnvelope(meta), "billing-application");

      const admission = admitMcpCall(app, {
        tool: "billing-workflow-start",
        meta: { "agboss.dev/mesh": meta },
        args: text,
        peer: undefined,
      });

      expect(admission.isAdmitted).toBe(expected === undefined);
      if (!admission.isAdmitted)
        expect(admission.refusal._meta?.["agboss.dev/error"]).toMatchObject({ code: expected });
    }
  });
});

describe("#961: a hand-built app with no mesh settings has no name to address", () => {
  it("is not refused by the audience check: nothing to match it against (A2A refuses to serve it)", () => {
    const admission = admitMcpCall(
      {},
      {
        tool: "any-tool",
        meta: { "agboss.dev/mesh": envelopeOf("invoices-application", false) },
        args: text,
        peer: undefined,
      },
    );

    expect(meshSettingsOf({})).toBeUndefined();
    expect(admission.isAdmitted).toBe(true);
  });
});
