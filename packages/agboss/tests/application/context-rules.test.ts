/**
 * #261 PR 3: the rules of the context subclasses an application declares, at its assembly — no
 * `prompt` on a context field (`[context.prompt-unused]`), every field decorated — and a subclass
 * a component injects but the application does not declare (`[context.not-declared]`); the
 * application level itself (`ApplicationContext`) and `testExecutionContext` with the levels.
 */
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { createApp } from "../../src/application/create-app.js";
import { Text } from "../../src/dto/index.js";
import {
  ApplicationContext,
  ExecutionContext,
  GraphRuleError,
  Injectable,
  TenantContext,
  Workflow,
} from "../../src/index.js";
import { ExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { seconds } from "../../src/units/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { testExecutionContext } from "../../src/testing/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import {
  ClinicExecutionContext,
  ClinicTenantContext,
  UnitDirectoryService,
} from "../flow/fixtures/clinic.fixture.js";
import { start } from "../helpers/flow.js";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import {
  OrdersAgent,
  OrdersWorkflowFinish,
  RefundsWorkflowStart,
} from "./fixtures/desks.application.js";
import { EmptyEnvironment } from "../../src/index.js";

class PlanTenantContext extends TenantContext {
  @Text({ prompt: "the plan of the organization" })
  plan!: string;
}

class UndecoratedExecutionContext extends ExecutionContext {
  userId!: string;
}

/** A service that injects the clinic's tenant level: its application must declare it. */
@Injectable({ deps: [ClinicTenantContext] })
class UnitNamesService {
  constructor(readonly clinicTenantContext: ClinicTenantContext) {}
}

const flow = [
  start(RefundsWorkflowStart)
    .returns(WorkflowStartTextDto)
    .toAgent(OrdersAgent)
    .toFinish(OrdersWorkflowFinish),
];

@Workflow({ name: "plain-workflow", version: "1.0.0", flow })
class PlainWorkflow {}

@Workflow({
  name: "units-workflow",
  version: "1.0.0",
  flow,
  providers: [UnitNamesService],
})
class UnitsWorkflow {}

@Application({
  name: "plan-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PlainWorkflow],
  budgets: TEST_BUDGETS,
  tenantContext: PlanTenantContext,
})
class PlanApplication {}

@Application({
  name: "undecorated-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PlainWorkflow],
  budgets: TEST_BUDGETS,
  executionContext: UndecoratedExecutionContext,
})
class UndecoratedApplication {}

@Application({
  name: "units-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [UnitsWorkflow],
  budgets: TEST_BUDGETS,
})
class UnitsApplication {}

@Application({
  name: "plain-application",
  version: "2.0.0",
  environment: EmptyEnvironment,
  workflows: [PlainWorkflow],
  budgets: TEST_BUDGETS,
})
class PlainApplication {}

const offline = { processEnv: {}, gateway: createScriptedGateway(new ScriptBook()) };

describe("#261 AC4: the declared context classes are checked at the application's assembly", () => {
  it("a prompt on a context field is [context.prompt-unused]: no model reads a context", async () => {
    const error: unknown = await applicationOf(PlanApplication).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GraphRuleError);
    expect((error as GraphRuleError).violations).toMatchObject([
      {
        code: "context.prompt-unused",
        message: "PlanTenantContext.plan has a prompt — no model reads a context; remove it",
      },
    ]);
  });

  it("a context field without a decorator fails the assembly, naming it", async () => {
    await expect(applicationOf(UndecoratedApplication)).rejects.toMatchObject({
      code: "dto.undecorated-field",
      message: expect.stringContaining("UndecoratedExecutionContext") as string,
    });
  });

  it("injecting a subclass the application does not declare is [context.not-declared]", async () => {
    await expect(applicationOf(UnitsApplication)).rejects.toThrow(
      "[context.not-declared] UnitNamesService injects ClinicTenantContext, which its application does not declare — @Application({ tenantContext: ClinicTenantContext })",
    );
  });
});

describe("#261 AC4: ApplicationContext — the one description of the running instance", () => {
  it("name, version, the chosen environment, the host; frozen", async () => {
    const app = await createApp(PlainApplication, offline);

    const context = app.resolve(ApplicationContext);
    expect(context).toMatchObject({
      name: "plain-application",
      version: "2.0.0",
      environmentName: "dev",
      environment: {},
      host: { pid: process.pid, platform: process.platform, runtimeVersion: process.version },
    });
    expect(context.startedAt).toBeInstanceOf(Date);
    expect(Object.isFrozen(context)).toBe(true);
    await app.close();
  });

  it("its instanceId is the holder of the instance's leases (#265 S63 g)", async () => {
    const app = await createApp(PlainApplication, offline);
    const leases = app.resolve(ExecutionLeaseRepository);

    const lease = await leases.acquire("default", "root-1", seconds(30));

    expect(lease?.holderInstanceId).toBe(app.resolve(ApplicationContext).instanceId);
    await app.close();
  });
});

describe("#261: testExecutionContext with the levels — units without the container", () => {
  it("a tenant subclass's values, linked up to a test application", () => {
    const executionContext = testExecutionContext({
      tenantContext: ClinicTenantContext,
      tenant: { tenantId: "acme", units: [{ unitId: "icu", name: "Intensive care" }] },
    });
    const service = new UnitDirectoryService(executionContext.tenant);

    expect(service.unitName("icu")).toBe("Intensive care");
    expect(executionContext.tenant).toMatchObject({ tenantId: "acme", weight: 1 });
    expect(executionContext.tenant.application.environmentName).toBe("test");
  });

  it("an execution subclass's values are its own fields; invalid ones fail like at execute", () => {
    const clinic = testExecutionContext({
      executionContext: ClinicExecutionContext,
      execution: { clinician: { clinicianId: "c-1" }, unitId: "icu" },
    });

    expect(clinic).toBeInstanceOf(ClinicExecutionContext);
    expect(clinic.unitId).toBe("icu");
    expect(clinic.tenant.tenantId).toBe("default");
    expect(clinic.root).toBe(clinic);
    expect(() =>
      testExecutionContext({
        executionContext: ClinicExecutionContext,
        // @ts-expect-error — `clinician` is required: the values are checked at run time too
        execution: { unitId: "x" },
      }),
    ).toThrow(/invalid ClinicExecutionContext: clinician/);
  });
});
