/**
 * #387 — the desk served over A2A to several tenants: a host's API-key directory, the caller
 * resolver that reads the key (listed in a workflow's providers, or in the application's), and an
 * observer that records what started or was refused.
 */
import {
  A2ACallerResolution,
  A2ARoute,
  type A2ACallerRequest,
  type A2ACallerResolver,
} from "../../../src/a2a/index.js";
import { Application } from "../../../src/application/application.js";
import { Injectable } from "../../../src/components/decorators.js";
import type { OnExecutionRejected, OnExecutionStart } from "../../../src/core/observer-hooks.js";
import type {
  ExecutionRejectedEvent,
  ExecutionStartEvent,
} from "../../../src/core/observability.js";
import { WorkflowStartTextDto } from "../../../src/dto/index.js";
import { EmptyEnvironment, Workflow, WorkflowStart } from "../../../src/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { Desk, DeskAnswer } from "./remote.workflow.js";

/** What one API key grants: its client, its tenant and whether it may answer pauses. */
export interface ApiKeyGrant {
  readonly clientId: string;
  readonly tenantId: string;
  readonly canAnswerPauses: boolean;
}

const GRANTS: Readonly<Record<string, ApiKeyGrant>> = {
  "key-acme": { clientId: "client-acme", tenantId: "acme", canAnswerPauses: true },
  "key-globex": { clientId: "client-globex", tenantId: "globex", canAnswerPauses: false },
};

/** The host's own service (a database in production). */
@Injectable()
export class ApiKeyDirectory {
  grantOf(apiKey: string): Promise<ApiKeyGrant | undefined> {
    return Promise.resolve(GRANTS[apiKey]);
  }
}

@WorkflowStart({
  name: "tenant-ask-workflow-start",
  description: "An order question of a tenant",
  input: WorkflowStartTextDto,
})
export class TenantAskStart {}

/** Who calls: a bearer API key → its tenant and client; never the default tenant. */
@Injectable({ deps: [ApiKeyDirectory] })
export class KeyCallerResolver implements A2ACallerResolver<typeof TenantAskStart> {
  constructor(private readonly apiKeyDirectory: ApiKeyDirectory) {}

  async resolveCaller(
    request: A2ACallerRequest,
  ): Promise<A2ACallerResolution<typeof TenantAskStart>> {
    const header: string = request.http.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) {
      return A2ACallerResolution.unauthenticated({
        reason: "no API key",
        challenge: 'Bearer realm="a2a"',
      });
    }
    const grant = await this.apiKeyDirectory.grantOf(header.slice("Bearer ".length));
    if (grant === undefined) return A2ACallerResolution.unauthenticated({ reason: "unknown API key" });
    if (request.route === A2ARoute.Resume && !grant.canAnswerPauses) {
      return A2ACallerResolution.forbidden({ reason: "this key may not answer pauses" });
    }
    return A2ACallerResolution.resolved({
      tenant: { tenantId: grant.tenantId },
      ownerId: grant.clientId,
    });
  }
}

/** A resolver whose directory is down: it throws. */
@Injectable()
export class FailingCallerResolver implements A2ACallerResolver<typeof TenantAskStart> {
  resolveCaller(): Promise<A2ACallerResolution<typeof TenantAskStart>> {
    return Promise.reject(new Error("directory down: password=hunter2"));
  }
}

/** A resolver no providers list. */
@Injectable()
export class UnlistedCallerResolver implements A2ACallerResolver<typeof TenantAskStart> {
  resolveCaller(): A2ACallerResolution<typeof TenantAskStart> {
    return A2ACallerResolution.resolved({});
  }
}

/** What started and what was refused, in order. */
export const tenantDeskSeen = {
  starts: [] as ExecutionStartEvent[],
  rejections: [] as ExecutionRejectedEvent[],
};

export function resetTenantDeskSeen(): void {
  tenantDeskSeen.starts.length = 0;
  tenantDeskSeen.rejections.length = 0;
}

@Injectable()
export class TenantDeskObserver implements OnExecutionStart, OnExecutionRejected {
  onExecutionStart(event: ExecutionStartEvent): void {
    tenantDeskSeen.starts.push(event);
  }

  onExecutionRejected(event: ExecutionRejectedEvent): void {
    tenantDeskSeen.rejections.push(event);
  }
}

const defaults = { models: { temperature: 0 }, tools: { maxToolCalls: 2 } } as const;

/** The desk, its resolvers in the workflow's providers. */
@Workflow({
  name: "tenant-desk-workflow",
  version: "1.0.0",
  flow: [
    start(TenantAskStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Desk)
      .toFinish(DeskAnswer),
  ],
  defaults,
  providers: [ApiKeyDirectory, KeyCallerResolver, FailingCallerResolver],
})
export class TenantDeskWorkflow {}

@Application({
  name: "tenant-desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [TenantDeskWorkflow],
  observers: [TenantDeskObserver],
  budgets: TEST_BUDGETS,
})
export class TenantDeskApplication {}

@WorkflowStart({
  name: "listed-ask-workflow-start",
  description: "An order question",
  input: WorkflowStartTextDto,
})
export class ListedAskStart {}

/** The same desk with no resolver of its own: the application lists it. */
@Workflow({
  name: "listed-desk-workflow",
  version: "1.0.0",
  flow: [
    start(ListedAskStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Desk)
      .toFinish(DeskAnswer),
  ],
  defaults,
})
export class ListedDeskWorkflow {}

@Application({
  name: "listed-desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ListedDeskWorkflow],
  providers: [ApiKeyDirectory, KeyCallerResolver], // ordinary services in the application's list
  budgets: TEST_BUDGETS,
})
export class ListedDeskApplication {}
