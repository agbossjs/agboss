/**
 * #808 AC1: `GET <base>/.well-known/agent-card.json` serves a valid A2A v1.0 card — its required
 * fields, one skill per exported start (tags default to the application's name), streaming on, the
 * skills extension with each skill's JSON Schemas, `securitySchemes` from `@A2AExpose({ security })`
 * and one JSONRPC 1.0 interface at `publicUrl` + `base`; the official SDK reads it.
 */
import { AgentCard } from "@a2a-js/sdk";
import { beforeEach, describe, expect } from "vitest";
import { A2A_MESH_EXTENSION, A2A_SKILLS_EXTENSION } from "../../../src/a2a/index.js";
import { testWith } from "../../../src/testing/index.js";
import { resetRecovery } from "../../infrastructure/fixtures/recovery.workflow.js";
import { BearerCallerResolver } from "../fixtures/bearer-caller-resolver.js";
import { DeskA2AExpose, ServedPausesApplication } from "../fixtures/served-pauses.application.js";
import { OrdersA2AExpose, OrdersApplication } from "../fixtures/task.application.js";
import { sdkClientOf } from "./sdk-client.js";

const orders = testWith(OrdersApplication);
const desk = testWith(ServedPausesApplication);

beforeEach(resetRecovery);

const cardAt = async (url: string) => {
  const response = await fetch(`${url}/.well-known/agent-card.json`);
  return { response, card: (await response.json()) as Record<string, unknown> };
};

describe("#808 AC1: the Agent Card", () => {
  orders(
    "at the well-known path: the required fields, one skill, streaming, security",
    async ({ a2aServer }) => {
      const { url } = await a2aServer({
        expose: OrdersA2AExpose,
        callerResolver: BearerCallerResolver,
      });

      const { response, card } = await cardAt(url);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("max-age=300");
      expect(card).toMatchObject({
        name: "orders-a2a-expose",
        description: "Takes orders: steps, holds and charges",
        version: "1.0.0",
        supportedInterfaces: [{ url, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
        capabilities: { streaming: true, pushNotifications: false },
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["application/json"],
        skills: [
          {
            id: "order-workflow-start",
            name: "order-workflow-start",
            description: "A request",
            tags: ["orders-application"],
            inputModes: ["text/plain"],
            outputModes: ["application/json"],
          },
        ],
        securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } },
        securityRequirements: [{ schemes: { bearer: {} } }],
      });
      // only the extension it serves
      const { extensions } = card.capabilities as {
        extensions: { uri: string; params: unknown }[];
      };
      expect(extensions.map((extension) => extension.uri)).toEqual([
        A2A_MESH_EXTENSION,
        A2A_SKILLS_EXTENSION,
      ]);
      // #810: an AGBoss peer — a messageId deduplicated as long as a finished task is kept
      expect(extensions[0]?.params).toEqual({
        idempotencyRetention: "PT86400S",
        messageIdempotencyRetention: "PT900S",
      });
      expect(() => AgentCard.fromJSON(card)).not.toThrow();
    },
  );

  desk(
    "two skills, each with its JSON Schemas in the skills extension; tags, examples and provider as declared",
    async ({ a2aServer }) => {
      const { url } = await a2aServer({
        expose: DeskA2AExpose,
        callerResolver: BearerCallerResolver,
        base: "/a2a",
        publicUrl: "https://desk.example.test/",
      });

      const { card } = await cardAt(url);

      expect(card).toMatchObject({
        supportedInterfaces: [{ url: "https://desk.example.test/a2a" }],
        provider: { organization: "Example Corp", url: "https://example.test" },
        defaultInputModes: ["text/plain", "application/json"],
        defaultOutputModes: ["text/plain", "application/json"],
      });
      const skills = card.skills as { id: string; tags: string[]; examples: string[] }[];
      expect(skills.map(({ id, tags }) => ({ id, tags }))).toEqual([
        { id: "desk-workflow-start", tags: ["served-pauses-application"] },
        { id: "audit-workflow-start", tags: ["audit", "refunds"] },
      ]);
      expect(skills[1]?.examples).toEqual(["refund order 7"]);
      const extension = (
        card.capabilities as { extensions: { uri: string; params: unknown }[] }
      ).extensions.find((declared) => declared.uri === A2A_SKILLS_EXTENSION);
      expect(extension?.params).toMatchObject({
        skills: {
          "audit-workflow-start": {
            input: { type: "object", properties: { orderId: expect.any(Object) as object } },
            schemaHash: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
            outputs: { "audit-workflow-finish": expect.any(Object) as object },
          },
        },
      });
    },
  );

  orders("an unchanged card is 304 with its entity tag", async ({ a2aServer }) => {
    const { url } = await a2aServer({
      expose: OrdersA2AExpose,
      callerResolver: BearerCallerResolver,
    });
    const { response } = await cardAt(url);
    const etag = response.headers.get("etag") ?? "";

    const again = await fetch(`${url}/.well-known/agent-card.json`, {
      headers: { "if-none-match": etag },
    });

    expect(etag).toMatch(/^".+"$/);
    expect(again.status).toBe(304);
  });

  orders(
    "#811: the card says when it was made (Last-Modified, the TCK's CARD-CACHE-003), the same on every read",
    async ({ a2aServer, clock }) => {
      const { url } = await a2aServer({
        expose: OrdersA2AExpose,
        callerResolver: BearerCallerResolver,
      });
      const madeAt = clock.now().toUTCString();
      const first = (await cardAt(url)).response.headers.get("last-modified");
      await clock.advance("1m");
      const later = (await cardAt(url)).response.headers.get("last-modified");

      expect([first, later]).toEqual([madeAt, madeAt]);
    },
  );

  orders("the official SDK client discovers the agent by its card", async ({ a2aServer }) => {
    const { url } = await a2aServer({
      expose: OrdersA2AExpose,
      callerResolver: BearerCallerResolver,
    });

    const client = await sdkClientOf(url);

    expect((await client.getAgentCard()).name).toBe("orders-a2a-expose");
    expect(client.protocolVersion).toBe("1.0");
  });

  orders(
    "a publicUrl that is no absolute http(s) URL stops the listener",
    async ({ a2aServer }) => {
      const listener = { expose: OrdersA2AExpose, callerResolver: BearerCallerResolver };

      await expect(a2aServer({ ...listener, publicUrl: "desk.example" })).rejects.toThrow(
        "[a2a.public-url-invalid]",
      );
      await expect(a2aServer({ ...listener, publicUrl: "ftp://desk.example" })).rejects.toThrow(
        "[a2a.public-url-invalid]",
      );
      await expect(a2aServer({ ...listener, base: "a2a/" })).rejects.toThrow("[a2a.base-invalid]");
    },
  );

  orders("any other route is 404", async ({ a2aServer }) => {
    const { url } = await a2aServer({
      expose: OrdersA2AExpose,
      callerResolver: BearerCallerResolver,
    });

    const response = await fetch(`${url}/execute`, { method: "POST", body: "{}" });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "a2a.not-found", error: "no such A2A route" });
  });
});
