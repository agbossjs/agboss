import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { A2AAdapter, a2aHttpListener } from "../../../src/a2a/index.js";
import type { AppOptions } from "../../../src/app/create-app.js";
import type { App } from "../../../src/app/types.js";
import {
  Agent,
  ExecutionContext,
  Workflow,
  WorkflowFinish,
  WorkflowSettings,
  WorkflowStart,
  type WorkflowDefinition,
  Tool,
  type ToolHandler,
} from "../../../src/index.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { createSqliteTernStore } from "../../../src/terns/index.js";
import type { ScriptBook } from "../../../src/testing/script-book.js";
import { createScriptedGateway } from "../../../src/testing/scripted-gateway.js";
import { start } from "../../helpers/flow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../../src/index.js";

export class LookupQuery {
  @Text({ prompt: "the order id" })
  orderId!: string;
}

export class LookupResult {
  @Text()
  status!: string;
}

/** Tells the test a slow lookup started (the cancel test waits for it). */
export const slowLookups = { started: (): void => undefined };

/** A lookup that runs until its run is aborted. */
@Tool({
  name: "slow_lookup",
  description: "Looks up an order slowly",
  input: LookupQuery,
  output: LookupResult,
  deps: [ExecutionContext],
})
export class SlowLookup implements ToolHandler<LookupQuery, LookupResult> {
  constructor(private readonly executionContext: ExecutionContext) {}

  run(_input: LookupQuery): Promise<LookupResult> {
    slowLookups.started();
    const { signal } = this.executionContext;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(new Error("lookup aborted"));
      });
    });
  }
}

/** A lookup that answers at once. */
@Tool({
  name: "quick_lookup",
  description: "Looks up an order",
  input: LookupQuery,
  output: LookupResult,
})
export class QuickLookup implements ToolHandler<LookupQuery, LookupResult> {
  run({ orderId }: LookupQuery): Promise<LookupResult> {
    return Promise.resolve({ status: `order ${orderId} shipped` });
  }
}

@Agent({
  name: "desk-agent",
  description: "Answers order questions",
  model: "test/desk",
  price: { inputPerMTok: 1, outputPerMTok: 2 },
  tools: [SlowLookup, QuickLookup],
})
export class Desk {}

@WorkflowStart({
  name: "ask-workflow-start",
  description: "An order question",
  input: WorkflowStartTextDto,
})
export class AskStart {}

@WorkflowFinish({
  name: "answer-workflow-finish",
  description: "The desk's answer",
  output: WorkflowFinishTextDto,
})
export class DeskAnswer {}

const defaults = {
  models: { temperature: 0, cache: true },
  router: { model: "typesafe/jev-1.13" },
  tools: { maxToolCalls: 2 },
} as const;

/** The workflow another workflow calls over A2A: start → desk → answer (at most 2 tool calls). */
@Workflow({
  name: "remote-desk-workflow",
  version: "1.0.0",
  flow: [
    start(AskStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Desk)
      .toFinish(DeskAnswer),
  ],
  defaults,
  uncompactedTurns: 2,
})
export class RemoteDesk implements WorkflowDefinition {
  settings(): WorkflowSettings {
    return WorkflowSettings.builder()
      .build();
  }
}

@Application({
  name: "remote-desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RemoteDesk],
  budgets: TEST_BUDGETS,
})
export class RemoteDeskApplication {}

/** Everything external given: scripted models, memory stores. */
export const offline = (book: ScriptBook): AppOptions => ({
  processEnv: {},
  gateway: createScriptedGateway(book),
});

/** An app's workflow served over A2A on an ephemeral local port. */
export interface Served {
  readonly url: string;
  readonly adapter: A2AAdapter;
  readonly close: () => Promise<void>;
}

/** Serves the app; `seen` gets each request's `authorization` header. */
export async function serve(app: App, seen: (string | undefined)[] = []): Promise<Served> {
  const adapter = new A2AAdapter(app);
  const listener = a2aHttpListener(adapter, AskStart);
  const server: Server = createServer((req, res) => {
    seen.push(req.headers.authorization);
    listener(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    adapter,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
      await app.close();
    },
  };
}
