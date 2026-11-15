/**
 * #961: an MCP server with no mesh settings — a host's own app, which no `@Application` made, so it
 * has no name of its own — cannot check an envelope's audience: there is no receiver name to
 * compare it with. A2A always has one (`A2AHttpBinding.mesh` is required), so the difference is
 * intended, and this pins what the nameless side does instead: it trusts nothing. Whatever the
 * envelope claims, a call is admitted without a peer, without a bodyHash, and its chain is an
 * untrusted claim.
 */
import { describe, expect, it } from "vitest";
import { admitMcpCall } from "../../src/mcp/mcp-mesh-gate.js";
import { encodeMeshEnvelope } from "../../src/mesh/mesh-envelope-codec.js";

/** An app no `@Application` made: `meshSettingsOf` has nothing for it. */
const hostApp = {};

const addressedTo = (audience: string): string =>
  encodeMeshEnvelope({
    schema: 1,
    issuer: "orders-application",
    audience,
    origin: {
      rootExecutionId: "root-1",
      executionId: "root-1",
      workflow: { name: "orders-workflow", version: "1.0.0" },
      step: { component: "orders-desk-agent", idempotencyKey: "root-1:orders-desk-agent:1:c1" },
    },
    callChain: [],
    bodyHash: "sha256:claimed",
  });

describe("#961: MCP without mesh settings does not check the audience (A2A always does)", () => {
  it("an envelope addressed to another application is admitted, untrusted", () => {
    const admission = admitMcpCall(hostApp, {
      tool: "any-tool",
      meta: { "agboss.dev/mesh": addressedTo("invoices-application") },
      args: {},
      peer: "orders-application",
    });

    // no settings: no peer keys, so the session's peer is not trusted, nothing of the claim is kept
    expect(admission).toEqual({ isAdmitted: true, inbound: { chain: [] } });
  });
});
