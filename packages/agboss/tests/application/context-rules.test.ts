/**
 * #261 PR 3: the rules of the context subclasses an application declares, at its assembly — no
 * `prompt` on a context field (`[context.prompt-unused]`), every field decorated — and a subclass
 * a component injects but the application does not declare (`[context.not-declared]`); the
 * application level itself (`ApplicationContext`) and `testExecutionContext` with the levels.
 */
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { Text } from "../../src/dto/index.js";
import {
  ApplicationContext,
  ExecutionContext,
  GraphRuleError,
  Injectable,
  TenantContext,
  Workflow,
  Ttl,
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
import { onStart } from "../helpers/flow.js";
import {
  OrdersAgent,
  OrdersWorkflowFinish,
  RefundsWorkflowStart,
} from "./fixtures/desks.application.js";
import { EmptyEnvironment } from "../../src/index.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

class PlanTenantContext extends TenantContext {
  @Text({ prompt: "the plan of the organization" })
  plan!: string;
}

class SpoofedTenantContext extends TenantContext {
  @Text() override tenantId = "";
}

class SpoofedExecutionContext extends ExecutionContext {
  @Text() override ownerId = "";
  // @ts-expect-error -- the spoof: a text field where the framework sets a record
  @Text() override handledError = "";
}

class OwnFieldsTenantContext extends TenantContext {
  @Text() region!: string;
}

class UndecoratedExecutionContext extends ExecutionContext {
  userId!: string;
}

/** A service that injects the clinic's tenant level: its application must declare it. */
@Injectable({ deps: [ClinicTenantContext] })
class UnitNamesService {
  constructor(readonly clinicTenantContext: ClinicTenantContext) {}
}

const flow = [onStart(RefundsWorkflowStart).toAgent(OrdersAgent).toFinish(OrdersWorkflowFinish)];

@Workflow({ name: "plain-workflow", version: "1.0.0", historyTtl: Ttl.Forever, flow })
class PlainWorkflow {}

@Workflow({
  name: "units-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow,
  providers: [UnitNamesService],
})
class UnitsWorkflow {}

@Application({
  name: "plan-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PlainWorkflow],
  budgets: TEST_BUDGETS,
  tenantContext: PlanTenantContext,
})
class PlanApplication {}

@Application({
  name: "spoofed-tenant-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PlainWorkflow],
  budgets: TEST_BUDGETS,
  tenantContext: SpoofedTenantContext,
})
class SpoofedTenantApplication {}

@Application({
  name: "spoofed-execution-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PlainWorkflow],
  budgets: TEST_BUDGETS,
  executionContext: SpoofedExecutionContext as never, // the spoof does not fit the context's type
})
class SpoofedExecutionApplication {}

@Application({
  name: "own-fields-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PlainWorkflow],
  budgets: TEST_BUDGETS,
  tenantContext: OwnFieldsTenantContext,
})
class OwnFieldsApplication {}

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
  modelProvider: TestModelProvider,
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

  it("a tenant field that shadows tenantId fails the assembly with [context.reserved-field] (#1316f)", async () => {
    const error: unknown = await applicationOf(SpoofedTenantApplication).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(GraphRuleError);
    expect((error as GraphRuleError).violations).toMatchObject([
      {
        code: "context.reserved-field",
        message:
          "SpoofedTenantContext.tenantId shadows a field the framework sets on every context — rename it",
      },
    ]);
  });

  it("an execution field that shadows ownerId or handledError fails it too", async () => {
    const error: unknown = await applicationOf(SpoofedExecutionApplication).catch(
      (thrown: unknown) => thrown,
    );

    expect((error as GraphRuleError).violations.map((found) => found.message)).toEqual([
      "SpoofedExecutionContext.ownerId shadows a field the framework sets on every context — rename it",
      "SpoofedExecutionContext.handledError shadows a field the framework sets on every context — rename it",
    ]);
  });

  it("a field of the project's own passes", async () => {
    await expect(applicationOf(OwnFieldsApplication)).resolves.toBeDefined();
  });

  it("a context field without a decorator fails the assembly, naming it", async () => {
    await expect(applicationOf(UndecoratedApplication)).rejects.toMatchObject({
      code: "config.dto",
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
    const app = await createTestAppWith(PlainApplication, offline);

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
    const app = await createTestAppWith(PlainApplication, offline);
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
