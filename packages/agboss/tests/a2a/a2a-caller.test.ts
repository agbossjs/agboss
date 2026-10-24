/**
 * #387: `a2aHttpListener(app, { start, callerResolver })` resolves each request's caller — its
 * tenant, owner and execution values — before reading the body; a caller it cannot resolve is
 * refused with a real HTTP status and nothing runs, never as the default tenant.
 */
import { beforeEach, describe, expect } from "vitest";
import {
  A2ACallerRejectedError,
  A2AClient,
  A2AStatus,
  a2aHttpListener,
} from "../../src/a2a/index.js";
import { ComponentError } from "../../src/components/metadata.js";
import { ExecutionRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { usd } from "../../src/units/index.js";
import { TestTenantDailyBudget } from "../flow/fixtures/budgets.js";
import { Desk } from "./fixtures/remote.workflow.js";
import {
  FailingCallerResolver,
  KeyCallerResolver,
  ListedAskStart,
  ListedDeskApplication,
  resetTenantDeskSeen,
  TenantAskStart,
  TenantDeskA2AExpose,
  ListedDeskA2AExpose,
  TenantDeskApplication,
  tenantDeskSeen,
  UnlistedCallerResolver,
} from "./fixtures/tenant-desk.workflow.js";

const test = testWith(TenantDeskApplication);
const listed = testWith(ListedDeskApplication);

const desk = { expose: TenantDeskA2AExpose, callerResolver: KeyCallerResolver } as const;
const bearer = (key: string): Record<string, string> => ({ authorization: `Bearer ${key}` });
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

beforeEach(resetTenantDeskSeen);

describe("#387 AC1: one listener, each request for its own tenant", () => {
  test("two keys (a resolver in @Workflow({ providers })) run as two tenants: one thread id is two threads, one budget limits one tenant", async ({
    app,
    a2aServer,
    mockLlm,
    mockOf,
  }) => {
    mockOf(TestTenantDailyBudget).maxSpend.mockReturnValue(usd(0.01));
    mockLlm(Desk).thenReturn(
      replyWith("Hello acme", { cost: usd(0.02) }), // spends acme's day
      replyWith("Hello globex", { cost: usd(0.001) }),
    );
    const { url } = await a2aServer(desk);
    const acme = new A2AClient({ url, headers: bearer("key-acme") });
    const globex = new A2AClient({ url, headers: bearer("key-globex") });

    const first = await acme.send({ text: "hi" }, { threadId: "ticket-7" });
    const other = await globex.send({ text: "hi" }, { threadId: "ticket-7" });
    const again = await acme.send({ text: "again" }, { threadId: "ticket-7" });

    const records = app.resolve(ExecutionRecordRepository);
    const has = (tenantId: string): Promise<boolean> =>
      records.hasThread("tenant-desk-workflow", tenantId, "ticket-7");
    expect(first).toMatchObject({ status: A2AStatus.Finished, threadId: "ticket-7" });
    expect(other).toMatchObject({ status: A2AStatus.Finished, output: { text: "Hello globex" } });
    expect(again).toMatchObject({ status: A2AStatus.Limited }); // acme's budget, not globex's
    expect(again.error).toContain("acme");
    expect(await Promise.all(["acme", "globex", "default"].map(has))).toEqual([true, true, false]);
    expect(tenantDeskSeen.starts.map((event) => [event.tenantId, event.threadId])).toEqual([
      ["acme", "ticket-7"],
      ["globex", "ticket-7"],
    ]);
  });

  listed(
    "a resolver listed in @Application({ providers }) is the container's",
    async ({ a2aServer, mockLlm }) => {
      mockLlm(Desk).thenReturn(replyWith("Hello acme"));
      const { url } = await a2aServer({
        expose: ListedDeskA2AExpose,
        callerResolver: KeyCallerResolver,
      });

      const response = await new A2AClient({ url, headers: bearer("key-acme") }).send({
        text: "hi",
      });

      expect(response).toMatchObject({
        status: A2AStatus.Finished,
        output: { text: "Hello acme" },
      });
    },
  );

  test("a resolver no providers list stops the listener at its start, naming the class", async ({
    app,
  }) => {
    await app.ready();

    const listen = () =>
      a2aHttpListener(app, { expose: TenantDeskA2AExpose, callerResolver: UnlistedCallerResolver });

    expect(listen).toThrow(ComponentError);
    expect(listen).toThrow(/a2a\.caller-resolver-not-listed.*UnlistedCallerResolver/);
  });
});

describe("#387 AC2: a caller the host cannot resolve is refused, nothing runs", () => {
  test("no key → 401 with the challenge: no model call, no observer event, no record", async ({
    app,
    a2aServer,
    mockLlm,
  }) => {
    const { url } = await a2aServer(desk);

    const response = await post(`${url}/execute`, { input: { text: "hi" }, threadId: "ticket-7" });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="a2a"');
    expect(await response.json()).toEqual({
      code: "a2a.caller-unauthenticated",
      error: "no API key",
    });
    expect(mockLlm(Desk)).toHaveBeenCalledTimes(0);
    expect(tenantDeskSeen).toEqual({ starts: [], rejections: [] });
    const records = app.resolve(ExecutionRecordRepository);
    expect(await records.hasThread("tenant-desk-workflow", "default", "ticket-7")).toBe(false);
  });

  test("an unknown key: the client throws A2ACallerRejectedError", async ({
    a2aServer,
    mockLlm,
  }) => {
    const { url } = await a2aServer(desk);

    const sent = new A2AClient({ url, headers: bearer("key-unknown") }).send({ text: "hi" });

    await expect(sent).rejects.toFailWith(A2ACallerRejectedError, {
      httpStatus: 401,
      code: "a2a.caller-rejected",
      wireCode: "a2a.caller-unauthenticated",
    });
    expect(mockLlm(Desk)).toHaveBeenCalledTimes(0);
  });

  test("a key that may not answer pauses → 403 on resume", async ({ a2aServer }) => {
    const { url } = await a2aServer(desk);

    const response = await post(
      `${url}/resume`,
      { pauseId: "pause-1", decision: { approved: true } },
      bearer("key-globex"),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: "a2a.caller-forbidden",
      error: "this key may not answer pauses",
    });
  });

  test("a resolver that throws → 500 without its text, and no run", async ({
    a2aServer,
    mockLlm,
  }) => {
    const { url } = await a2aServer({
      expose: TenantDeskA2AExpose,
      callerResolver: FailingCallerResolver,
    });

    const response = await post(`${url}/execute`, { input: { text: "hi" } }, bearer("key-acme"));

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ code: "a2a.caller-resolution-failed" });
    expect(body).not.toContain("hunter2");
    expect(mockLlm(Desk)).toHaveBeenCalledTimes(0);
    expect(tenantDeskSeen.starts).toEqual([]);
  });

  test("a streaming request is refused with a real 401, not an event stream", async ({
    a2aServer,
  }) => {
    const { url } = await a2aServer(desk);

    const response = await post(
      `${url}/execute`,
      { input: { text: "hi" } },
      {
        accept: "text/event-stream",
      },
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/json");
  });
});
