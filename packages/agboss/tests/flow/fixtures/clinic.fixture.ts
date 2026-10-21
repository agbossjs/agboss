import { TerminalUserChannel } from "../../../src/channels/terminal-channel.js";
import { Injectable, Tool, type ToolHandler } from "../../../src/components/decorators.js";
import { ListOf, Nested, Text } from "../../../src/dto/index.js";
import { PiiAction } from "../../../src/pii/actions.js";
import { ApplicationContext } from "../../../src/flow/context/application-context.js";
import { ExecutionContext } from "../../../src/flow/context/execution-context.js";
import { TenantContext } from "../../../src/flow/context/tenant-context.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { Application } from "../../../src/application/application.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import { TEST_BUDGETS } from "./budgets.js";
import type { OnExecutionRejected } from "../../../src/core/observer-hooks.js";
import type { ExecutionRejectedEvent } from "../../../src/core/observability.js";
import { WorkflowStartTextDto } from "./dtos.js";
import { start } from "./paths.js";

/**
 * #261 PR 3 — a clinic: the project's tenant level (its units) and execution level (the clinician
 * talking now) declared once in `@Application({ tenantContext, executionContext })`, injected by a
 * service, a tool and an action. No field of a context has a `prompt`: no model reads it.
 */

export class UnitDto {
  @Text()
  unitId!: string;

  @Text()
  name!: string;
}

export class ClinicianDto {
  @Text({ sensitive: PiiAction.replaceWithKind() })
  clinicianId!: string;
}

export class ClinicTenantContext extends TenantContext {
  @ListOf(UnitDto)
  units!: UnitDto[];
}

export class ClinicExecutionContext extends ExecutionContext {
  @Nested(ClinicianDto)
  clinician!: ClinicianDto;

  @Text()
  unitId!: string;
}

/** What the clinic's components read of their contexts, in order (`resetClinicSeen`). */
export interface ClinicReading {
  readonly tenantId: string;
  readonly weight: number;
  readonly unitName: string;
  readonly clinicianId: string;
  readonly applicationName: string;
  readonly sameTenant: boolean;
}

export const clinicSeen = {
  readings: [] as ClinicReading[],
  /** The tenant objects the action saw: frozen, linked to the application. */
  tenants: [] as TenantContext[],
  /** The requests refused before an execution started. */
  rejections: [] as ExecutionRejectedEvent[],
};

export function resetClinicSeen(): void {
  clinicSeen.readings.length = 0;
  clinicSeen.tenants.length = 0;
  clinicSeen.rejections.length = 0;
}

/** Records every refused request (an invalid context value is one). */
@Injectable()
export class ClinicRejectionsObserver implements OnExecutionRejected {
  onExecutionRejected(event: ExecutionRejectedEvent): void {
    clinicSeen.rejections.push(event);
  }
}

/** The organization's level: a unit's name from the tenant's own data. */
@Injectable({ deps: [ClinicTenantContext] })
export class UnitDirectoryService {
  constructor(private readonly clinicTenantContext: ClinicTenantContext) {}

  unitName(unitId: string): string {
    const unit = this.clinicTenantContext.units.find((candidate) => candidate.unitId === unitId);
    return unit?.name ?? unitId;
  }
}

export class BedQueryDto {
  @Text({ prompt: "the ward" })
  ward!: string;
}

export class BedsDto {
  @Text({ prompt: "the free beds" })
  text!: string;
}

/** Reads the clinician's unit and the tenant (#261: one object of its level, the rest through it). */
@Tool({
  name: "free-beds-tool",
  description: "Free beds in the clinician's unit",
  input: BedQueryDto,
  output: BedsDto,
  deps: [ClinicExecutionContext, UnitDirectoryService],
})
export class FreeBedsTool implements ToolHandler<BedQueryDto, BedsDto> {
  constructor(
    private readonly clinicExecutionContext: ClinicExecutionContext,
    private readonly unitDirectoryService: UnitDirectoryService,
  ) {}

  run(input: BedQueryDto): Promise<BedsDto> {
    const { tenant, clinician, unitId } = this.clinicExecutionContext;
    clinicSeen.readings.push({
      tenantId: tenant.tenantId,
      weight: tenant.weight,
      unitName: this.unitDirectoryService.unitName(unitId),
      clinicianId: clinician.clinicianId,
      applicationName: tenant.application.name,
      sameTenant: this.clinicExecutionContext.tenant === tenant,
    });
    return Promise.resolve({ text: `2 beds in ${input.ward}` });
  }
}

/** A write tool: it waits for an approval, so the execution pauses before it. */
@Tool({
  name: "book-bed-tool",
  description: "Books a bed",
  channel: TerminalUserChannel,
  input: BedQueryDto,
  output: BedsDto,
  deps: [ClinicExecutionContext],
})
export class BookBedTool implements ToolHandler<BedQueryDto, BedsDto> {
  constructor(private readonly clinicExecutionContext: ClinicExecutionContext) {}

  run(input: BedQueryDto): Promise<BedsDto> {
    const { tenant, clinician } = this.clinicExecutionContext;
    clinicSeen.readings.push({
      tenantId: tenant.tenantId,
      weight: tenant.weight,
      unitName: input.ward,
      clinicianId: clinician.clinicianId,
      applicationName: tenant.application.name,
      sameTenant: true,
    });
    return Promise.resolve({ text: `booked ${input.ward}` });
  }
}

@Agent({
  name: "bed-agent",
  description: "Finds and books beds",
  prompt: "Find a bed.",
  tools: [FreeBedsTool, BookBedTool],
  model: "test/bed",
  input: { message: WorkflowStartTextDto },
  output: BedsDto,
})
export class BedAgent {}

/** The base tokens give the declared levels too; `ApplicationContext` is the instance's one object. */
@Action({
  name: "audit-bed-action",
  description: "Audits the request",
  deps: [TenantContext, ApplicationContext, ExecutionContext],
})
export class AuditBedAction {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly applicationContext: ApplicationContext,
    private readonly executionContext: ExecutionContext,
  ) {}

  execute(): Promise<void> {
    clinicSeen.tenants.push(this.executionContext.tenant);
    clinicSeen.readings.push({
      tenantId: this.tenantContext.tenantId,
      weight: this.tenantContext.weight,
      unitName: "",
      clinicianId: "",
      applicationName: this.applicationContext.name,
      sameTenant: this.tenantContext.application === this.applicationContext,
    });
    return Promise.resolve();
  }
}

@WorkflowStart({
  name: "bed-request-workflow-start",
  description: "A bed request",
  input: WorkflowStartTextDto,
})
export class BedRequestWorkflowStart {}

@WorkflowFinish({ name: "beds-workflow-finish", description: "The beds", output: BedsDto })
export class BedsWorkflowFinish {}

@Workflow({
  name: "bed-request-workflow",
  version: "1.0.0",
  defaults: { models: { maxTokens: 100, temperature: 0 }, tools: { maxToolCalls: 3 } },
  providers: [UnitDirectoryService],
  flow: [
    start(BedRequestWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(BedAgent)
      .returns(BedsDto)
      .toAction(AuditBedAction)
      .toFinish(BedsWorkflowFinish),
  ],
})
export class BedRequestWorkflow {}

@Application({
  name: "clinic-application",
  version: "2.1.0",
  environment: EmptyEnvironment,
  workflows: [BedRequestWorkflow],
  observers: [ClinicRejectionsObserver],
  budgets: TEST_BUDGETS,
  tenantContext: ClinicTenantContext,
  executionContext: ClinicExecutionContext,
})
export class ClinicApplication {}
