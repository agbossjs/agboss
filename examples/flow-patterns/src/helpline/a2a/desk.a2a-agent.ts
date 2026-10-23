import { ExecutionContext } from "agboss";
import { A2AAgent, A2AClient } from "agboss/a2a";
import { usd } from "agboss/units";
import { DeskCallDto, DeskReplyDto } from "../dtos/desk-call.dto.js";

/**
 * The help desk of `desk-application`, a declared contract (#398 PR 3): its start, what it is sent
 * and gives back, its price. `agboss describe --json` lists it under `contracts.imports`, and
 * `check --federation` checks it against the desk's own snapshot — no network.
 */
@A2AAgent({
  name: "desk-a2a-agent",
  url: "http://127.0.0.1:4100/a2a", // the desk's listener, on this host
  target: { application: "desk-application", start: "desk-workflow-start" },
  input: DeskCallDto,
  output: DeskReplyDto,
  price: usd(0.001), // per call: counted in the calling tool's spend
  deps: [ExecutionContext],
})
export class DeskA2AAgent extends A2AClient<DeskCallDto, DeskReplyDto> {
  constructor(private readonly executionContext: ExecutionContext) {
    super();
  }

  /** The desk's caller resolver reads the tenant from this header (and only from this host). */
  protected override getHeaders(): Promise<Record<string, string>> {
    return Promise.resolve({ "x-tenant-id": this.executionContext.tenant.tenantId });
  }
}
