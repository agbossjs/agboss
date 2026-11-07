/**
 * #809 — the A2A v1.0 client against a foreign agent on the official SDK's own server (in process,
 * no socket): discovery and its checks, the origins it talks to, typed and untyped calls, each
 * outcome, polling and streaming, a dropped stream, and what of a remote error it keeps.
 */
import { describe, expect, it } from "vitest";
import { AgentEvent } from "@a2a-js/sdk/server";
import {
  A2ACallerRejectedError,
  A2AClient,
  A2AContractError,
  A2AContractRule,
  A2AOriginError,
  A2AOriginSite,
  A2APeerKind,
  A2AProtocolError,
  A2ARemoteCallError,
  A2ATaskCanceledError,
  A2ATaskFailedError,
  A2ATaskInterruptedError,
  A2ATaskInterruption,
  TaskState,
  type A2AStreamEvent,
} from "../../../src/a2a/index.js";
import { A2A_SKILLS_EXTENSION } from "../../../src/a2a/a2a-extension-uris.js";
import { HopsLimitExceededError } from "../../../src/index.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { hours } from "../../../src/units/index.js";
import { AGENT_URL, scripts, SdkAgent, urlOf, workingThen } from "./support/sdk-agent.js";

class InvoiceQuestionDto {
  @Text()
  invoiceId!: string;
}

class InvoiceAnswerDto {
  @Text()
  status!: string;
}

const clientOf = (agent: SdkAgent, options: ConstructorParameters<typeof A2AClient>[0] = {}) =>
  new A2AClient<InvoiceQuestionDto, InvoiceAnswerDto>({
    url: AGENT_URL,
    fetcher: agent.fetcher,
    contract: { input: InvoiceQuestionDto, output: InvoiceAnswerDto },
    ...options,
  });

/** A fetcher that records every request it is handed (URL and headers), then asks `next`. */
function recording(next: typeof fetch) {
  const seen: { readonly url: string; readonly headers: Headers }[] = [];
  const fetcher: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, headers: new Headers(init?.headers) });
    return next(input, init);
  };
  return { seen, fetcher };
}

describe("#809: discovery", () => {
  it("a v0.3-only agent is A2AProtocolError naming its version; nothing is sent", async () => {
    const legacy = { name: "old", url: AGENT_URL, protocolVersion: "0.3.0", skills: [] };
    const agent = new SdkAgent({ script: scripts.messageEcho, rawCard: legacy });

    const sent = clientOf(agent).send("hi");

    await expect(sent).rejects.toBeInstanceOf(A2AProtocolError);
    await expect(sent).rejects.toMatchObject({
      protocolVersions: ["0.3.0"],
      operation: "agent-card",
    });
    await expect(sent).rejects.toThrow(/declares A2A 0\.3\.0/);
    expect(agent.received).toEqual([]);
  });

  it("an unknown skill is [a2a.unknown-skill] before anything is sent", async () => {
    const agent = new SdkAgent({ script: scripts.messageEcho });

    const sent = clientOf(agent, { contract: { skill: "refund-workflow-start" } }).send("hi");

    await expect(sent).rejects.toMatchObject({ rule: A2AContractRule.UnknownSkill });
    expect(agent.received).toEqual([]);
  });

  it("a skill whose schema refuses the client's DTO is [a2a.schema-mismatch] before sending", async () => {
    const skills = {
      "ask-workflow-start": {
        input: {
          type: "object",
          properties: { invoiceId: { type: "integer" } },
          required: ["invoiceId"],
          additionalProperties: false,
        },
        outputs: {},
      },
    };
    const agent = new SdkAgent({
      script: scripts.messageEcho,
      agboss: { idempotencyRetention: hours(24), skills },
    });

    const run = clientOf(agent).execute({ invoiceId: "inv-7" });

    await expect(run).rejects.toBeInstanceOf(A2AContractError);
    await expect(run).rejects.toMatchObject({ rule: A2AContractRule.SchemaMismatch });
    await expect(run).rejects.toMatchObject({
      differences: [expect.stringMatching(/^input: invoiceId/u)],
    });
    expect(agent.received).toEqual([]);
  });

  it("the card is read once per cardTtl, and says what the client relies on", async () => {
    const agent = new SdkAgent({ script: scripts.messageEcho });
    const client = clientOf(agent);

    const first = await client.send("a");
    await client.send("b");

    expect(agent.cardFetches).toBe(1);
    expect(first.peer).toEqual({
      kind: A2APeerKind.Foreign,
      idempotencyRetention: undefined,
      mesh: false,
    });
  });

  it("a card that fails is A2AProtocolError with its status only", async () => {
    const fetcher: typeof fetch = () =>
      Promise.resolve(new Response("boom: secret@example.com", { status: 500 }));
    const sent = new A2AClient({ url: AGENT_URL, fetcher }).send("hi");

    await expect(sent).rejects.toMatchObject({ httpStatus: 500, operation: "agent-card" });
    await expect(sent).rejects.not.toThrow(/secret/);
  });
});

describe("#809 security: the client talks to its own origins only", () => {
  const foreignCard = (agent: SdkAgent) => ({
    ...agent.card,
    supportedInterfaces: [
      {
        url: "https://evil.example/a2a",
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: "1.0",
      },
    ],
  });

  it("a card naming an interface elsewhere is refused, and nothing with credentials goes there", async () => {
    const base = new SdkAgent({ script: scripts.messageEcho });
    const agent = new SdkAgent({ script: scripts.messageEcho, rawCard: foreignCard(base) });
    const { seen, fetcher } = recording(agent.fetcher);
    const client = new A2AClient({
      url: AGENT_URL,
      fetcher,
      headers: { authorization: "Bearer s3cret" },
    });

    const sent = client.send("hi");

    await expect(sent).rejects.toBeInstanceOf(A2AOriginError);
    await expect(sent).rejects.toMatchObject({
      origin: "https://evil.example",
      site: A2AOriginSite.CardInterface,
    });
    expect(seen.map((request) => new URL(request.url).origin)).toEqual(["http://agent.test"]);
  });

  it("an interface on a listed origin is used", async () => {
    const agent = new SdkAgent({ script: scripts.messageEcho });
    const elsewhere = {
      ...agent.card,
      supportedInterfaces: [
        {
          url: "http://rpc.agent.test/a2a",
          protocolBinding: "JSONRPC",
          tenant: "",
          protocolVersion: "1.0",
        },
      ],
    };
    const fetcher: typeof fetch = (input, init) => {
      const url = urlOf(input);
      if (url.endsWith("agent-card.json")) return Promise.resolve(Response.json(elsewhere));
      return agent.fetcher(url.replace("http://rpc.agent.test/a2a", AGENT_URL), init);
    };

    const result = await new A2AClient({
      url: AGENT_URL,
      fetcher,
      allowedOrigins: ["http://rpc.agent.test"],
    }).send("hi");

    expect(result.text).toBe("HI");
  });

  it("a redirect of the card to another origin is refused, never followed", async () => {
    const { seen, fetcher } = recording(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/card.json" },
        }),
      ),
    );

    const sent = new A2AClient({
      url: AGENT_URL,
      fetcher,
      headers: { authorization: "Bearer s3cret" },
    }).send("hi");

    await expect(sent).rejects.toMatchObject({
      site: A2AOriginSite.Redirect,
      origin: "https://evil.example",
    });
    expect(seen).toHaveLength(1);
  });

  it("an allowedOrigins entry that is no origin is refused at construction", () => {
    expect(
      () => new A2AClient({ url: AGENT_URL, allowedOrigins: ["https://rpc.example/path"] }),
    ).toThrow(/\[a2a\.allowed-origin-invalid\]/);
  });
});

describe("#809: typed and untyped calls against a foreign agent", () => {
  it("execute sends one data part and returns the COMPLETED task's output, validated", async () => {
    const agent = new SdkAgent({ script: scripts.completeWith({ data: { status: "paid" } }) });

    const answer = await clientOf(agent).execute({ invoiceId: "inv-7" });

    expect(answer).toEqual({ status: "paid" });
    expect(agent.received[0]?.parts).toEqual([
      { data: { invoiceId: "inv-7" }, mediaType: "application/json" },
    ]);
    expect(agent.received[0]?.metadata).toEqual({
      "https://agboss.dev/a2a/skills/v1": { skill: "ask-workflow-start" },
    });
  });

  it("a text start and a text finish travel as text parts", async () => {
    const agent = new SdkAgent({ script: scripts.completeWith({ text: "shipped" }) });
    const client = new A2AClient<WorkflowStartTextDto, WorkflowFinishTextDto>({
      url: AGENT_URL,
      fetcher: agent.fetcher,
      contract: { input: WorkflowStartTextDto, output: WorkflowFinishTextDto },
    });

    const answer = await client.execute({ text: "where is #7?" });

    expect(answer).toEqual({ text: "shipped" });
    expect(agent.received[0]?.parts).toEqual([{ text: "where is #7?", mediaType: "text/plain" }]);
  });

  it("send returns a stateless message's text", async () => {
    const agent = new SdkAgent({ script: scripts.messageEcho });

    const result = await clientOf(agent).send("hello");

    expect(result).toMatchObject({ task: undefined, text: "HELLO" });
    expect(result.message?.messageId).toMatch(/^answer-/);
  });

  it("a typed call answered by a message without its output is A2ARemoteCallError", async () => {
    const agent = new SdkAgent({ script: scripts.messageEcho });

    await expect(clientOf(agent).execute({ invoiceId: "x" })).rejects.toBeInstanceOf(
      A2ARemoteCallError,
    );
  });

  it("INPUT_REQUIRED: send returns the task, execute throws A2ATaskInterruptedError, reply continues it", async () => {
    const agent = new SdkAgent({
      script: async (context, bus, self) => {
        if (context.task === undefined) {
          await scripts.endWith(TaskState.TASK_STATE_INPUT_REQUIRED, "which invoice?")(
            context,
            bus,
            self,
          );
          return;
        }
        await scripts.completeWith({ data: { status: "paid" } })(context, bus, self);
      },
    });
    const client = clientOf(agent);

    const asked = await client.send({ data: { invoiceId: "?" } });
    const interrupted = client.execute({ invoiceId: "?" });
    const replied = await client.reply(asked.task?.id ?? "", { data: { invoiceId: "inv-7" } });

    expect(asked.task?.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    await expect(interrupted).rejects.toMatchObject({
      interruption: A2ATaskInterruption.InputRequired,
    });
    await expect(interrupted).rejects.toBeInstanceOf(A2ATaskInterruptedError);
    expect(replied.data).toEqual({ status: "paid" });
  });

  it("FAILED is A2ATaskFailedError without the status text; CANCELED A2ATaskCanceledError", async () => {
    const failing = new SdkAgent({
      script: scripts.endWith(TaskState.TASK_STATE_FAILED, "db down for alice@example.com"),
    });
    const canceling = new SdkAgent({
      script: scripts.endWith(TaskState.TASK_STATE_CANCELED, "stopped"),
    });

    const failed = await clientOf(failing)
      .send("x")
      .catch((error: unknown) => error);
    const canceled = clientOf(canceling).send("x");

    expect(failed).toBeInstanceOf(A2ATaskFailedError);
    expect(
      JSON.stringify({ message: String(failed), details: (failed as A2ATaskFailedError).details }),
    ).not.toMatch(/alice|db down/);
    await expect(canceled).rejects.toBeInstanceOf(A2ATaskCanceledError);
  });

  it("an AGBoss peer's mesh limit code is rebuilt as the same limit error", async () => {
    const entry = { application: "billing-application", start: "billing-workflow-start" };
    const chain = [
      { application: "orders-application", start: "orders-workflow-start", executionId: "e-1" },
    ];
    const metadata = {
      "https://agboss.dev/a2a/mesh/v1": {
        code: "limit.hops",
        details: { entry, chain, maxMeshHops: 1 },
      },
    };
    const agent = new SdkAgent({
      script: scripts.endWith(TaskState.TASK_STATE_REJECTED, "too many hops", metadata),
    });

    await expect(clientOf(agent).send("x")).rejects.toBeInstanceOf(HopsLimitExceededError);
  });

  it("a JSON-RPC error keeps its code, never the agent's message", async () => {
    const agent = new SdkAgent({ script: scripts.messageEcho });

    const replied = clientOf(agent).reply("no-such-task", "hello");

    await expect(replied).rejects.toMatchObject({ rpcCode: -32001, operation: "SendMessage" });
    await expect(replied).rejects.toThrow(
      /^A2A agent A2AClient answered SendMessage with JSON-RPC error -32001$/u,
    );
  });

  it("a refused caller is A2ACallerRejectedError with its code (the server's reason is not kept)", async () => {
    const fetcher: typeof fetch = (input, init) =>
      urlOf(input).endsWith("agent-card.json")
        ? new SdkAgent({ script: scripts.messageEcho }).fetcher(input, init)
        : Promise.resolve(
            Response.json(
              { code: "a2a.caller-forbidden", error: "key k-123 is revoked" },
              { status: 403 },
            ),
          );

    const sent = new A2AClient({ url: AGENT_URL, fetcher }).send("hi");

    await expect(sent).rejects.toBeInstanceOf(A2ACallerRejectedError);
    await expect(sent).rejects.toMatchObject({ httpStatus: 403, wireCode: "a2a.caller-forbidden" });
    await expect(sent).rejects.not.toThrow(/k-123/);
  });

  it("headers: the static ones and getHeaders() on every request", async () => {
    const agent = new SdkAgent({ script: scripts.messageEcho });
    class TokenClient extends A2AClient {
      protected override getHeaders(): Promise<Record<string, string>> {
        return Promise.resolve({ authorization: "Bearer fresh" });
      }
    }

    await new TokenClient({
      url: AGENT_URL,
      fetcher: agent.fetcher,
      headers: { "x-tenant-id": "acme" },
    }).send("hi");

    expect(agent.received[0]?.headers).toMatchObject({
      authorization: "Bearer fresh",
      "x-tenant-id": "acme",
      "a2a-version": "1.0",
    });
  });
});

describe("#809: waiting — polling, streaming, a dropped stream", () => {
  it("a WORKING task is polled until it completes", async () => {
    const agent = new SdkAgent({ script: workingThen() });
    const events: A2AStreamEvent[] = [];
    const run = clientOf(agent).execute(
      { invoiceId: "inv-7" },
      { onEvent: (event) => events.push(event) },
    );

    await untilHeld(agent);
    const [taskId] = agent.held.keys();
    agent.finish(taskId ?? "", TaskState.TASK_STATE_COMPLETED, { data: { status: "paid" } });

    await expect(run).resolves.toEqual({ status: "paid" });
    expect(agent.count("GetTask")).toBeGreaterThanOrEqual(1);
    expect(agent.count("SubscribeToTask")).toBe(0);
    expect(events.at(-1)?.payload?.$case).toBe("task");
  });

  it("a streaming agent is subscribed to; a dropped stream is opened again", async () => {
    const agent = new SdkAgent({ script: workingThen(), streaming: true });
    agent.cutStreams = [1]; // the first stream dies after its first event (the task)
    const run = clientOf(agent).execute({ invoiceId: "inv-7" });

    await untilHeld(agent);
    await until(() => agent.count("SubscribeToTask") >= 2);
    const [taskId] = agent.held.keys();
    agent.finish(taskId ?? "", TaskState.TASK_STATE_COMPLETED, { data: { status: "paid" } });

    await expect(run).resolves.toEqual({ status: "paid" });
    expect(agent.count("SubscribeToTask")).toBe(2);
  });

  // #809 acceptance: an AGBoss server streams the model's text as a "stream" artifact, then the
  // finish's output artifact (metadata[skills-uri].finish) — the output is that artifact alone
  it("a streamed text chunk artifact beside the finish's output artifact: the output is read once", async () => {
    const agent = new SdkAgent({ script: workingThen(), streaming: true });
    const typed = new A2AClient<WorkflowStartTextDto, WorkflowFinishTextDto>({
      url: AGENT_URL,
      fetcher: agent.fetcher,
      contract: { input: WorkflowStartTextDto, output: WorkflowFinishTextDto },
    });
    const finishWithChunks = () => {
      const [entry] = agent.held.values();
      if (entry === undefined) throw new Error("no held task");
      const { context, bus, release } = entry;
      const ids = { taskId: context.taskId, contextId: context.contextId, metadata: undefined };
      const text = (value: string) => ({
        content: { $case: "text" as const, value },
        metadata: undefined,
        filename: "",
        mediaType: "text/plain",
      });
      const artifact = (artifactId: string, metadata?: Record<string, unknown>) => ({
        artifactId,
        name: "",
        description: "",
        parts: [text("Shipped.")],
        metadata,
        extensions: [],
      });
      bus.publish(
        AgentEvent.artifactUpdate({
          ...ids,
          artifact: artifact("stream"),
          append: true,
          lastChunk: false,
        }),
      );
      bus.publish(
        AgentEvent.artifactUpdate({
          ...ids,
          artifact: artifact(`${context.taskId}:output`, {
            [A2A_SKILLS_EXTENSION]: { finish: "answer-workflow-finish" },
          }),
          append: false,
          lastChunk: true,
        }),
      );
      bus.publish(
        AgentEvent.statusUpdate({
          ...ids,
          status: {
            state: TaskState.TASK_STATE_COMPLETED,
            message: undefined,
            timestamp: new Date(0).toISOString(),
          },
        }),
      );
      bus.finished();
      agent.held.delete(context.taskId);
      release();
    };

    const run = typed.execute({ text: "where is #7?" });
    await untilHeld(agent);
    finishWithChunks();
    const sent = clientOf(agent).send("again");
    await untilHeld(agent);
    finishWithChunks();

    await expect(run).resolves.toEqual({ text: "Shipped." });
    await expect(sent).resolves.toMatchObject({ text: "Shipped." });
  });
});

async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !condition(); tries += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!condition()) throw new Error("never reached");
}

const untilHeld = (agent: SdkAgent): Promise<void> => until(() => agent.held.size > 0);
