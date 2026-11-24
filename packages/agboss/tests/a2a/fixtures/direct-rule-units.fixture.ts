// #860 (mutation shard `a2a-direct`) — the nodes the direct-reply rule reads on its own: a question
// role and an approval tool as an agent's tools, a tool of no decorator, an agent of none; services
// that reach an effect after a harmless one, an A2A client, an injection token, a cycle of deps; an
// action committed with no undo; two agents sharing a tool that writes.
import { A2AAgent, A2AClient } from "../../../src/a2a/index.js";
import { McpServer } from "../../../src/components/decorators.js";
import { McpServerClient } from "../../../src/components/mcp-client.js";
import { McpTransport } from "../../../src/config/mcp-server-config.js";
import { Idempotency } from "../../../src/app/idempotency.js";
import { OwnerToolApproval } from "../../flow/fixtures/owner-approval.fixture.js";
import { Injectable, Tool } from "../../../src/components/decorators.js";
import { InjectionToken, type Class } from "../../../src/components/injection.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import type { Tracked } from "../../../src/index.js";
import { TckInputQuestion } from "../../a2a-tck/tck.application.js";
import { LedgerReadTool } from "./direct-rules.fixture.js";
import { inline } from "../../../src/index.js";

interface Message {
  readonly message: Tracked<WorkflowStartTextDto>;
}

/** A tool the run pauses before: it reads only. */
@Tool({
  name: "approved-read-tool",
  description: "Reads, once approved",
  approval: OwnerToolApproval,
  input: WorkflowStartTextDto,
  output: WorkflowFinishTextDto,
  readOnly: true,
})
export class ApprovedReadTool {
  execute(): Promise<WorkflowFinishTextDto> {
    return Promise.resolve({ text: "read" });
  }
}

/** No decorator: another rule names it. */
export class PlainTool {
  readonly role = "no tool";
}

@Agent({
  name: "asking-agent",
  description: "Asks its caller, asks for approval, calls a class of no decorator",
  prompt: inline("Answer."),
  model: "moonshotai/kimi-k2.6",
  tools: [TckInputQuestion, ApprovedReadTool, PlainTool as never],
})
export class AskingAgent {}

@Agent({ name: "plain-agent", description: "Tools: none", prompt: inline("Answer."), model: "x/y" })
export class PlainAgent {}

@Agent({
  name: "first-ledger-agent",
  description: "Reads the ledger",
  prompt: inline("Answer."),
  model: "x/y",
  tools: [LedgerReadTool],
})
export class FirstLedgerAgent {}

@Agent({
  name: "second-ledger-agent",
  description: "Reads the ledger too",
  prompt: inline("Answer."),
  model: "x/y",
  tools: [LedgerReadTool],
})
export class SecondLedgerAgent {}

@A2AAgent({ name: "rule-a2a-agent", url: "https://peer.example" })
export class RuleA2AAgent extends A2AClient {}

@Injectable()
export class HarmlessService {}

export const REGION = new InjectionToken<string>("region");

/** A service whose deps come back to it. */
const loopDeps: Class[] = [];
@Injectable({ deps: loopDeps as [] })
export class LoopService {}
loopDeps.push(LoopService);

const action = (name: string, deps: readonly unknown[]) => {
  @Action({ name, description: name, input: { message: WorkflowStartTextDto }, deps: deps as [] })
  class Made {
    execute(_input: Message): Promise<void> {
      return Promise.resolve();
    }
  }
  return Made;
};

/** Harmless first, the effect second. */
export const LateEffectAction = action("late-effect-action", [HarmlessService, Idempotency]);
export const CallingAction = action("calling-action", [RuleA2AAgent]);
export const TokenAction = action("token-action", [REGION, LoopService]);

@Action({
  name: "confirm-action",
  description: "Confirms",
  input: { message: WorkflowStartTextDto },
})
export class ConfirmAction {
  execute(_input: Message): Promise<void> {
    return Promise.resolve();
  }
}

@Action({
  name: "committed-action",
  description: "Committed, no undo",
  input: { message: WorkflowStartTextDto },
  committedBy: ConfirmAction,
})
export class CommittedAction {
  execute(_input: Message): Promise<void> {
    return Promise.resolve();
  }
}

/** An abstract port, bound to an MCP server with `injectAs`. */
export abstract class RemoteSearchPort {
  abstract search(): void;
}

@McpServer({
  name: "port-mcp-server",
  transport: McpTransport.Stdio,
  command: "unused",
  tools: {},
  injectAs: RemoteSearchPort,
})
export class PortMcpServer
  extends McpServerClient<Record<string, never>>
  implements RemoteSearchPort
{
  search(): void {
    return undefined;
  }
}

/** An abstract port nothing in the application is bound to. */
export abstract class UnboundPort {
  abstract read(): void;
}

export const PortAction = action("port-action", [RemoteSearchPort]);
export const UnboundPortAction = action("unbound-port-action", [UnboundPort]);
