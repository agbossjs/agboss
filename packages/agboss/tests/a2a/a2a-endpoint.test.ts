/**
 * #1320a: `@A2AEndpoint` — a typed `skills` list (a start, or a start with options) and a required
 * `ttl`. Checked at assembly (`[a2a.ttl-invalid]`, `[a2a.duplicate-skill]`,
 * `[application.endpoint-unknown-start]`, `[a2a.unknown-skill-option]`), and served: two endpoints on
 * one store never see each other's tasks or message ids, a card advertises its endpoint's ttl, a
 * `publicUrl` may be a function.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  A2AEndpoint,
  A2AReply,
  skillOptionsOf,
  startsOfEndpoint,
  type A2AEndpointOptions,
} from "../../src/a2a/a2a-endpoint.decorator.js";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { assemblyWarningsOf } from "../../src/application/start-log.js";
import { componentOf } from "../../src/components/metadata.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { EmptyEnvironment } from "../../src/index.js";
import { callTool, testWith } from "../../src/testing/index.js";
import { hours, minutes, seconds, Ttl } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import {
  Charge,
  Clerk,
  OrderWorkflowStart,
  RecoveryWorkflow,
  resetRecovery,
} from "../infrastructure/fixtures/recovery.workflow.js";
import { BearerAuthenticator, resetAsked } from "./fixtures/bearer-authenticator.js";
import { RefundWorkflow, RefundWorkflowStart } from "./fixtures/contracts.workflow.js";
import { rpc, text, userMessage } from "./server/rpc.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

const TTL = { tasks: hours(24), messages: minutes(15) };

/** An application serving one `@A2AEndpoint` over the refund workflow. */
function applicationWith(endpoint: Partial<A2AEndpointOptions>) {
  @A2AEndpoint({
    name: "refunds",
    version: "1.0.0",
    description: "Refunds",
    ttl: TTL,
    skills: [RefundWorkflowStart],
    ...endpoint,
  })
  class RefundsEndpoint {}

  @Application({
    name: "refunds-application",
    modelProvider: TestModelProvider,
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [RefundWorkflow],
    budgets: TEST_BUDGETS,
    endpoints: [RefundsEndpoint],
  })
  class RefundsApplication {}
  return { application: RefundsApplication, endpoint: RefundsEndpoint };
}

const assembled = (endpoint: Partial<A2AEndpointOptions>) =>
  applicationOf(applicationWith(endpoint).application, { withoutIdempotencyKeys: true });

describe("#1320a: @A2AEndpoint is checked at assembly", () => {
  it("a start, or a start with options, in one skills list", async () => {
    const { endpoint } = applicationWith({
      skills: [{ start: RefundWorkflowStart, tags: ["refunds"], reply: A2AReply.Task }],
    });
    const meta = componentOf(endpoint);
    if (meta?.kind !== "a2a-endpoint") throw new Error("not an endpoint");

    expect(startsOfEndpoint(meta.meta)).toEqual([RefundWorkflowStart]);
    expect(skillOptionsOf(meta.meta, "refund-workflow-start")?.tags).toEqual(["refunds"]);
    await expect(assembled({})).resolves.toBeDefined();
  });

  it("a skill with no tags of its own is a warning, whichever way it is listed", async () => {
    const tagged = await assembled({ skills: [{ start: RefundWorkflowStart, tags: ["refunds"] }] });
    const untagged = await assembled({ skills: [{ start: RefundWorkflowStart }] });

    const skillTags = (found: Awaited<ReturnType<typeof assembled>>) =>
      assemblyWarningsOf({ ...found }).filter((warning) => warning.code === "a2a.skill-tags");
    expect(skillTags(tagged)).toEqual([]);
    expect(skillTags(untagged)).toHaveLength(1);
  });

  it.each([
    ["Ttl.Forever for tasks", { tasks: Ttl.Forever, messages: minutes(15) }, true],
    ["a message ttl just above the lease", { tasks: hours(1), messages: seconds(30) + 1 }, true],
    ["a message ttl at the lease", { tasks: hours(1), messages: seconds(30) }, false],
    ["a message ttl below the lease", { tasks: hours(1), messages: seconds(1) }, false],
    ["a zero task ttl", { tasks: 0, messages: minutes(15) }, false],
    ["a negative task ttl", { tasks: -5, messages: minutes(15) }, false],
    ["a NaN message ttl", { tasks: hours(1), messages: Number.NaN }, false],
    ["Ttl.None for tasks", { tasks: Ttl.None, messages: minutes(15) }, false],
    ["no ttl at all", undefined, false],
  ])("[a2a.ttl-invalid]: %s", async (_name, ttl, isValid) => {
    const built = assembled({ ttl: ttl as never });

    if (isValid) await expect(built).resolves.toBeDefined();
    else {
      await expect(built).rejects.toBeInstanceOf(GraphRuleError);
      await expect(built).rejects.toThrow(/\[a2a\.ttl-invalid\] refunds's ttl\./u);
    }
  });

  it("[a2a.duplicate-skill]: a start listed twice, plain and with options", async () => {
    const built = assembled({ skills: [RefundWorkflowStart, { start: RefundWorkflowStart }] });

    await expect(built).rejects.toThrow(
      "[a2a.duplicate-skill] refunds lists the skill RefundWorkflowStart twice — one entry per start",
    );
  });

  it("[application.endpoint-unknown-start]: a start of no listed workflow", async () => {
    const built = assembled({ skills: [OrderWorkflowStart] });

    await expect(built).rejects.toThrow(
      "[application.endpoint-unknown-start] refunds serves OrderWorkflowStart, which is no @WorkflowStart of refunds-application's workflows",
    );
  });

  it("[a2a.unknown-skill-option]: a defaultSkill that is no skill of the endpoint", async () => {
    const built = assembled({ defaultSkill: OrderWorkflowStart });

    await expect(built).rejects.toThrow(
      "[a2a.unknown-skill-option] refunds's defaultSkill OrderWorkflowStart is not one of its exports",
    );
  });
});

@A2AEndpoint({
  name: "orders-a",
  version: "1.0.0",
  description: "The first door to the orders",
  ttl: { tasks: hours(2), messages: minutes(20) },
  skills: [OrderWorkflowStart],
  provider: { organization: "Example Corp", url: "https://example.test" },
})
class OrdersAEndpoint {}

@A2AEndpoint({
  name: "orders-b",
  version: "1.0.0",
  description: "The second door to the same orders",
  ttl: { tasks: Ttl.Forever, messages: minutes(5) },
  skills: [OrderWorkflowStart],
})
class OrdersBEndpoint {}

@Application({
  name: "two-doors-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RecoveryWorkflow],
  providers: [BearerAuthenticator],
  endpoints: [OrdersAEndpoint, OrdersBEndpoint],
  budgets: TEST_BUDGETS,
})
class TwoDoorsApplication {}

const test = testWith(TwoDoorsApplication);

beforeEach(() => {
  resetRecovery();
  resetAsked();
});

/** The id of the task a first message to `url` started. */
async function startedTask(url: string, messageId: string): Promise<string> {
  const sent = await rpc(url, "SendMessage", { message: userMessage(messageId, [text("go")]) });
  return (sent.body.result as { task: { id: string } }).task.id;
}

describe("#1320a: two endpoints on one store", () => {
  test("a task of one endpoint is not found, listed or cancelled through the other", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const a = await a2aServer({
      endpoint: OrdersAEndpoint,
      authenticator: BearerAuthenticator,
      base: "/a",
    });
    const b = await a2aServer({
      endpoint: OrdersBEndpoint,
      authenticator: BearerAuthenticator,
      base: "/b",
    });
    const taskId = await startedTask(a.url, "m-1");

    const own = await rpc(a.url, "GetTask", { id: taskId });
    const other = await rpc(b.url, "GetTask", { id: taskId });
    const cancel = await rpc(b.url, "CancelTask", { id: taskId });
    const listedA = await rpc(a.url, "ListTasks", {});
    const listedB = await rpc(b.url, "ListTasks", {});

    expect(own.body.error).toBeUndefined();
    expect((other.body.error as { code: number }).code).toBe(-32001);
    expect((cancel.body.error as { code: number }).code).toBe(-32001);
    expect((listedA.body.result as { tasks: unknown[] }).tasks).toHaveLength(1);
    expect((listedB.body.result as { tasks: unknown[] }).tasks).toEqual([]);
  });

  test("a message id used at one endpoint is another message at the other", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const a = await a2aServer({
      endpoint: OrdersAEndpoint,
      authenticator: BearerAuthenticator,
      base: "/a",
    });
    const b = await a2aServer({
      endpoint: OrdersBEndpoint,
      authenticator: BearerAuthenticator,
      base: "/b",
    });
    const first = await startedTask(a.url, "m-1");

    const again = await rpc(a.url, "SendMessage", { message: userMessage("m-1", [text("go")]) });
    const other = await rpc(b.url, "SendMessage", { message: userMessage("m-1", [text("go")]) });

    expect((again.body.result as { task: { id: string } }).task.id).toBe(first);
    expect((other.body.error as { data?: unknown }).data).toBeDefined();
    expect(JSON.stringify(other.body)).toContain("a2a.message-id-reused");
  });

  test("each card advertises its endpoint's own ttl and provider", async ({ a2aServer }) => {
    const a = await a2aServer({
      endpoint: OrdersAEndpoint,
      authenticator: BearerAuthenticator,
      base: "/a",
    });
    const b = await a2aServer({
      endpoint: OrdersBEndpoint,
      authenticator: BearerAuthenticator,
      base: "/b",
    });

    const cardOf = async (url: string) =>
      (await (await fetch(`${url}/.well-known/agent-card.json`)).json()) as {
        provider?: unknown;
        capabilities: { extensions: { params?: unknown }[] };
      };
    const cardA = await cardOf(a.url);
    const cardB = await cardOf(b.url);

    expect(cardA.capabilities.extensions[0]?.params).toEqual({
      idempotencyRetention: "PT7200S",
      messageIdempotencyRetention: "PT1200S",
    });
    expect(cardA.provider).toEqual({ organization: "Example Corp", url: "https://example.test" });
    expect(cardB.capabilities.extensions[0]?.params).toMatchObject({
      messageIdempotencyRetention: "PT300S",
    });
    expect(cardB.provider).toBeUndefined();
  });

  test("a publicUrl that is a function is asked at the first request", async ({ a2aServer }) => {
    let asked = 0;
    const served = await a2aServer({
      endpoint: OrdersAEndpoint,
      authenticator: BearerAuthenticator,
      base: "/a",
      publicUrl: () => {
        asked += 1;
        return "https://orders.example.test";
      },
    });
    const before = asked;

    const card = (await (await fetch(`${served.url}/.well-known/agent-card.json`)).json()) as {
      supportedInterfaces: { url: string }[];
    };

    expect([before, asked]).toEqual([0, 1]);
    expect(card.supportedInterfaces[0]?.url).toBe("https://orders.example.test/a");
  });

  test("a publicUrl function that gives no URL fails the request, not the listener", async ({
    a2aServer,
  }) => {
    const served = await a2aServer({
      endpoint: OrdersAEndpoint,
      authenticator: BearerAuthenticator,
      base: "/a",
      publicUrl: () => "not a url",
    });

    const answer = await fetch(`${served.url}/.well-known/agent-card.json`);

    expect(answer.status).toBe(503);
  });
});
