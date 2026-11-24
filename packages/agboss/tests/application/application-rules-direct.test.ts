/**
 * #1366: the rules of an `@Application` itself, called directly with the options the assembly reads: each
 * violation's code, its exact message and the node it names, what a missing list means (none) and what is skipped
 * (a class that is no workflow). The shard `assembly-rules` mutates `application-rules.ts` whole.
 */
import { describe, expect, it } from "vitest";
import type { ApplicationOptions } from "../../src/application/application.js";
import {
  applicationRuleViolations,
  listedClassesOf,
} from "../../src/application/application-rules.js";
import { Budget, BudgetPeriod, BudgetScope } from "../../src/budgets/budget.js";
import { EmptyEnvironment, Injectable } from "../../src/index.js";
import { ModelCost, ModelProvider, RetryPolicy } from "../../src/models/index.js";
import type { TransportModelProviderOptions } from "../../src/models/model-provider.decorator.js";
import { minutes, seconds, usd, type Usd } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { RuleRefundApprovalChannel } from "../flow/fixtures/refunds.fixture.js";
import { answer } from "../models/transport/bedrock-provider.fixture.js";
import {
  DeskDirectoryService,
  OrdersAgent,
  OrdersWorkflow,
  OrdersWorkflowFinish,
  OrdersWorkflowStart,
  RecordingCostLedgerRepository,
  SpendReportService,
} from "./fixtures/desks.application.js";
import { Workflow } from "../../src/index.js";
import { testDefaults } from "../helpers.js";
import { onStart } from "../helpers/flow.js";
import { CircuitBreakerPolicy } from "../../src/models/circuit-breaker-policy.js";

class ShopApplication {
  readonly fixture = true;
}
class Application {
  readonly fixture = true;
}

const options = (rest: Partial<ApplicationOptions>): ApplicationOptions => ({
  name: "shop-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [OrdersWorkflow],
  budgets: TEST_BUDGETS,
  ...rest,
});

const found = (application: object, given: ApplicationOptions) =>
  applicationRuleViolations(application as typeof ShopApplication, given).map((violation) => ({
    code: violation.code,
    message: violation.message,
    nodes: violation.nodes,
  }));

@Budget({ name: "daily", scope: BudgetScope.Application, period: BudgetPeriod.Day })
class DailyLimit {
  maxSpend(): Usd {
    return usd(1);
  }
}

class NotABudget {
  readonly fixture = true;
}

const transport = (name: string): TransportModelProviderOptions => ({
  name,
  description: "A transport",
  serves: [/^bedrock\//],
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 1,
    failureWindow: minutes(1),
    openDuration: minutes(1),
  }),
});

@ModelProvider(transport("shop-model-provider"))
class ShopModelProvider {
  complete() {
    return Promise.resolve(answer("never"));
  }
}

@ModelProvider(transport("Shop_Provider"))
class MisnamedModelProvider {
  complete() {
    return Promise.resolve(answer("never"));
  }
}

@Injectable()
class PlainService {
  readonly fixture = true;
}

@Workflow({
  name: "infra-workflow",
  version: "1.0.0",
  defaults: testDefaults,
  flow: [onStart(OrdersWorkflowStart).toAgent(OrdersAgent).toFinish(OrdersWorkflowFinish)],
  providers: [
    RecordingCostLedgerRepository,
    ShopModelProvider,
    RuleRefundApprovalChannel,
    PlainService,
  ],
})
class InfraWorkflow {
  readonly fixture = true;
}

describe("#1366: applicationRuleViolations", () => {
  it("finds nothing in a good application with the lists left out", () => {
    expect(found(ShopApplication, options({ budgets: TEST_BUDGETS }))).toEqual([]);
  });

  it("names a name and a class that do not end with their kind, the class at its length", () => {
    expect(found(Application, options({ name: "shop" }))).toEqual([
      {
        code: "name.kind-suffix",
        message: '"shop" on @Application — name it "shop-application"',
        nodes: ["shop"],
      },
      {
        code: "name.kind-suffix",
        message: "class Application — name it ApplicationApplication",
        nodes: ["shop"],
      },
    ]);
  });

  it("names an application that lists no workflows, and a class in the list that is none", () => {
    expect(found(ShopApplication, options({ workflows: [] }))).toEqual([
      {
        code: "application.no-workflows",
        message:
          "shop-application lists no workflows — add them: @Application({ workflows: [...] })",
        nodes: ["shop-application"],
      },
    ]);
    expect(
      found(ShopApplication, options({ workflows: [OrdersWorkflow, OrdersAgent, PlainService] })),
    ).toEqual([
      {
        code: "application.not-a-workflow",
        message: "OrdersAgent in shop-application's workflows is not a @Workflow class",
        nodes: ["shop-application"],
      },
      {
        code: "application.not-a-workflow",
        message: "PlainService in shop-application's workflows is not a @Workflow class",
        nodes: ["shop-application"],
      },
    ]);
  });

  it("names a budget without the decorator, and one whose name or class lacks its kind", () => {
    expect(
      found(ShopApplication, options({ budgets: [...TEST_BUDGETS, NotABudget, DailyLimit] })),
    ).toEqual([
      {
        code: "budget.not-a-budget",
        message:
          "NotABudget in shop-application's budgets has no @Budget({ name, scope, … }) decorator",
        nodes: ["shop-application"],
      },
      {
        code: "name.kind-suffix",
        message: '"daily" on @Budget — name it "daily-budget"',
        nodes: ["daily"],
      },
      {
        code: "name.kind-suffix",
        message: "class DailyLimit — name it DailyLimitBudget",
        nodes: ["daily"],
      },
    ]);
  });

  it("names an anonymous class in the budgets, and reads an application with no budgets listed", () => {
    const anonymous = (() =>
      class {
        readonly fixture = true;
      })();
    const bare: ApplicationOptions = {
      name: "shop-application",
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [OrdersWorkflow],
    };

    expect(
      found(ShopApplication, options({ budgets: [...TEST_BUDGETS, anonymous] })).map(
        (one) => one.message,
      ),
    ).toEqual([
      "(anonymous class) in shop-application's budgets has no @Budget({ name, scope, … }) decorator",
    ]);
    expect(
      found(ShopApplication, bare).filter((one) => one.code.startsWith("budget.not-a")),
    ).toEqual([]);
  });

  it("names a listed model provider whose name lacks its kind", () => {
    const given = options({ providers: [ShopModelProvider, MisnamedModelProvider] });

    expect(found(ShopApplication, given)).toEqual([
      {
        code: "name.not-kebab-case",
        message: '"Shop_Provider" on @ModelProvider — a name is kebab-case: "shop-provider"',
        nodes: ["shop-application"],
      },
    ]);
  });

  it("names infrastructure listed in a workflow by what makes it so, and not a service", () => {
    expect(found(ShopApplication, options({ workflows: [InfraWorkflow] }))).toEqual([
      {
        code: "di.infrastructure-in-workflow",
        message:
          "RecordingCostLedgerRepository extends CostLedgerRepository — infrastructure is listed only in @Application({ providers }), not in infra-workflow's providers",
        nodes: ["infra-workflow"],
      },
      {
        code: "di.infrastructure-in-workflow",
        message:
          "ShopModelProvider is a @ModelProvider — infrastructure is listed only in @Application({ providers }), not in infra-workflow's providers",
        nodes: ["infra-workflow"],
      },
      {
        code: "di.infrastructure-in-workflow",
        message:
          "RuleRefundApprovalChannel is a @Channel (channel transport) — infrastructure is listed only in @Application({ providers }), not in infra-workflow's providers",
        nodes: ["infra-workflow"],
      },
    ]);
  });

  it("reads a class that is no component, and an application with no providers listed", () => {
    class Undecorated {
      readonly fixture = true;
    }
    @Workflow({
      name: "plain-workflow",
      version: "1.0.0",
      defaults: testDefaults,
      flow: [onStart(OrdersWorkflowStart).toAgent(OrdersAgent).toFinish(OrdersWorkflowFinish)],
      providers: [Undecorated],
    })
    class PlainWorkflow {
      readonly fixture = true;
    }
    @Workflow({
      name: "bare-workflow",
      version: "1.0.0",
      defaults: testDefaults,
      flow: [onStart(OrdersWorkflowStart).toAgent(OrdersAgent).toFinish(OrdersWorkflowFinish)],
    })
    class BareWorkflow {
      readonly fixture = true;
    }

    expect(found(ShopApplication, options({ workflows: [PlainWorkflow] }))).toEqual([]);
    expect(found(ShopApplication, options({ workflows: [BareWorkflow] }))).toEqual([]);
    expect(listedClassesOf(options({ workflows: [BareWorkflow] }))).toEqual([]);
  });

  it("reads no infrastructure in the classes of a non-workflow", () => {
    expect(found(ShopApplication, options({ workflows: [OrdersWorkflow, PlainService] }))).toEqual([
      expect.objectContaining({ code: "application.not-a-workflow" }),
    ]);
  });
});

describe("#1366: listedClassesOf", () => {
  it("lists the application's classes then every workflow's, and skips what is no workflow", () => {
    expect(
      listedClassesOf(
        options({ providers: [PlainService], workflows: [OrdersWorkflow, OrdersAgent] }),
      ),
    ).toEqual([PlainService, DeskDirectoryService, SpendReportService]);
  });

  it("lists nothing when nothing is listed", () => {
    expect(listedClassesOf(options({ workflows: [] }))).toEqual([]);
    expect(
      listedClassesOf(options({ providers: [RecordingCostLedgerRepository], workflows: [] })),
    ).toEqual([RecordingCostLedgerRepository]);
    expect(RuleRefundApprovalChannel).toBeDefined();
  });
});
