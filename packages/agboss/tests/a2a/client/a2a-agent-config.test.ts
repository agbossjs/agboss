/**
 * #1320b: what `@A2AAgent` declares — `url`, `headers`, `allowedOrigins` — may be `defineEnv`
 * references, read once from the application's environment; a missing variable is named, never a
 * value; headers merge without regard to case (declared, then the option's, then `getHeaders()`),
 * and `getHeaders()` may be sync.
 */
import { describe, expect, it } from "vitest";
import { A2AAgent } from "../../../src/a2a/a2a-decorator.js";
import { hasReferences, resolvedAgentOf } from "../../../src/a2a/client/a2a-agent-config.js";
import { A2AClient } from "../../../src/a2a/client/a2a-client.js";
import { bearer, defineEnv, env, secret } from "../../../src/index.js";
import { seconds } from "../../../src/units/index.js";
import { AGENT_URL, scripts, SdkAgent } from "./support/sdk-agent.js";

const appEnv = defineEnv({
  billingUrl: env("BILLING_URL"),
  billingOrigin: env("BILLING_ORIGIN"),
  billingKey: secret("BILLING_KEY"),
  tenantHeader: env("TENANT_HEADER"),
});

const VARIABLES = {
  BILLING_URL: "https://billing.example/a2a",
  BILLING_ORIGIN: "https://rpc.billing.example",
  BILLING_KEY: "k-live-123",
  TENANT_HEADER: "acme",
};

describe("#1320b: references in an agent's declaration", () => {
  const declared = {
    url: appEnv.billingUrl,
    allowedOrigins: [appEnv.billingOrigin, "https://other.example"],
    headers: {
      authorization: bearer(appEnv.billingKey),
      "x-tenant": appEnv.tenantHeader,
      "x-static": "plain",
      "x-key": appEnv.billingKey,
    },
  };

  it("are read once from the environment: texts, a secret revealed, a bearer made of one", () => {
    const read = resolvedAgentOf("billing", declared, VARIABLES);

    expect(read).toEqual({
      url: "https://billing.example/a2a",
      allowedOrigins: ["https://rpc.billing.example", "https://other.example"],
      headers: {
        authorization: "Bearer k-live-123",
        "x-tenant": "acme",
        "x-static": "plain",
        "x-key": "k-live-123",
      },
    });
  });

  it("a variable that is missing is named, its siblings' values never are", () => {
    const { BILLING_URL: _gone, ...rest } = VARIABLES;
    let message = "";
    try {
      resolvedAgentOf("billing", declared, rest);
    } catch (error) {
      message = String(error);
    }

    expect(message).toContain("BILLING_URL");
    expect(message).not.toContain("k-live-123");
  });

  it("only a declaration with a reference needs the environment", () => {
    expect(hasReferences({ url: "https://a.example", allowedOrigins: [], headers: {} })).toBe(
      false,
    );
    expect(hasReferences({ ...declared, url: "https://a.example", allowedOrigins: [] })).toBe(true);
    expect(hasReferences({ url: appEnv.billingUrl, allowedOrigins: [], headers: {} })).toBe(true);
  });
});

describe("#1320b: a client's request headers", () => {
  it("declared headers, the option's and a sync getHeaders() merge without regard to case; the last wins", async () => {
    @A2AAgent({
      name: "billing-a2a-agent",
      url: AGENT_URL,
      headers: { Authorization: "Bearer declared", "X-Declared": "yes" },
      timeout: seconds(5),
    })
    class BillingAgent extends A2AClient {
      protected override getHeaders(): Record<string, string> {
        return { authorization: "Bearer fresh", "X-AGBoss-Mesh": "forged" };
      }
    }
    const agent = new SdkAgent({ script: scripts.messageEcho });

    await new BillingAgent({
      fetcher: agent.fetcher,
      headers: { AUTHORIZATION: "Bearer option", "x-option": "yes" },
    }).send("hi");

    const seen = agent.received[0]?.headers;
    expect(seen).toMatchObject({
      authorization: "Bearer fresh",
      "x-declared": "yes",
      "x-option": "yes",
    });
    // the framework's header is the mesh's alone: a client's own never rides
    expect(seen?.["x-agboss-mesh"]).toBeUndefined();
  });

  it("a plain declared url is the client's url; a malformed one never constructs", () => {
    @A2AAgent({ name: "plain-a2a-agent", url: AGENT_URL })
    class Plain extends A2AClient {}
    @A2AAgent({ name: "bad-a2a-agent", url: "not a url" })
    class Bad extends A2AClient {}

    expect(new Plain().url).toBe(AGENT_URL);
    expect(() => new Bad()).toThrow(/\[a2a\.url-invalid\] bad-a2a-agent/u);
  });

  it("a reference url reads the process environment outside an application", () => {
    process.env.A2A_TEST_URL = AGENT_URL;
    try {
      const own = defineEnv({ url: env("A2A_TEST_URL") });
      @A2AAgent({ name: "env-a2a-agent", url: own.url })
      class FromEnv extends A2AClient {}

      expect(new FromEnv().url).toBe(AGENT_URL);
    } finally {
      delete process.env.A2A_TEST_URL;
    }
  });
});
