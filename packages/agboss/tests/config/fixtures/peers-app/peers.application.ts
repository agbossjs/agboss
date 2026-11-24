import { A2AAgent } from "../../../../src/a2a/a2a-decorator.js";
import { A2AClient } from "../../../../src/a2a/client/a2a-client.js";
import { Application } from "../../../../src/application/application.js";
import { McpServer } from "../../../../src/components/decorators.js";
import { McpServerClient } from "../../../../src/components/mcp-client.js";
import { McpTransport } from "../../../../src/config/mcp-server-config.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../../src/dto/index.js";
import { EmptyEnvironment } from "../../../../src/environments/empty.js";
import { Action, Workflow, WorkflowFinish, WorkflowStart } from "../../../../src/index.js";
import { seconds, usd } from "../../../../src/units/index.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { onStart } from "../../../helpers/flow.js";

/** An HTTP MCP server: a bound on a call, a price, a concurrency cap. */
@McpServer({
  name: "peer-notes",
  transport: McpTransport.Http,
  url: "https://notes.example/mcp",
  timeout: seconds(10),
  costPerCall: usd(0.001),
  maxConcurrentCalls: 2,
  tools: {},
})
export class PeerNotesServer extends McpServerClient<Record<string, never>> {}

/** A stdio MCP server: a process the application starts. */
@McpServer({
  name: "peer-runner",
  transport: McpTransport.Stdio,
  command: "node",
  args: ["runner.js"],
  timeout: seconds(5),
  tools: {},
})
export class PeerRunnerServer extends McpServerClient<Record<string, never>> {}

/** A foreign A2A agent, priced by contract. */
@A2AAgent({
  name: "peer-billing",
  url: "https://billing.example",
  timeout: seconds(20),
  costPerCall: usd(0.02),
})
export class PeerBillingAgent extends A2AClient {}

/** A foreign A2A agent with no price. */
@A2AAgent({ name: "peer-free", url: "https://free.example" })
export class PeerFreeAgent extends A2AClient {}

@WorkflowStart({
  name: "peers-workflow-start",
  description: "A question",
  input: WorkflowStartTextDto,
})
class PeersStart {}

@WorkflowFinish({
  name: "peers-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
class PeersFinish {}

/** Says what its two peers are, as the application runs them. */
@Action({
  name: "peers-action",
  description: "Tells how its peers are set",
  input: { question: WorkflowStartTextDto },
  output: WorkflowFinishTextDto,
  timeout: seconds(60),
  deps: [PeerNotesServer, PeerRunnerServer, PeerBillingAgent, PeerFreeAgent],
})
export class PeersAction {
  constructor(
    readonly notes: PeerNotesServer,
    readonly runner: PeerRunnerServer,
    readonly billing: PeerBillingAgent,
    readonly free: PeerFreeAgent,
  ) {}

  execute(): WorkflowFinishTextDto {
    const price = this.billing.contract?.costPerCall;
    return {
      text: `${this.billing.url} ${String(price)} ${String(this.billing.contract?.timeout)}`,
    };
  }
}

@Workflow({
  name: "peers-workflow",
  version: "1.0.0",
  flow: [onStart(PeersStart).toAction(PeersAction).toFinish(PeersFinish)],
})
export class PeersWorkflow {}

@Application({
  name: "peers-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PeersWorkflow],
  providers: [PeerBillingAgent, PeerFreeAgent],
  budgets: TEST_BUDGETS,
})
export class PeersApplication {}

export { PeersStart };
