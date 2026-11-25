import { describe, expect, it } from "vitest";
import {
  Agent,
  Budget,
  BudgetScope,
  EmptyEnvironment,
  GraphRuleError,
  Injectable,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type BudgetHandler,
  inline,
  Ttl,
} from "../../src/index.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import type { Class } from "../../src/components/injection.js";
import type { ToolHandlerClass } from "../../src/components/decorators.js";
import { usd, type Usd } from "../../src/units/index.js";
import {
  TEST_BUDGETS,
  TestApplicationDailyBudget,
  TestTenantDailyBudget,
} from "../flow/fixtures/budgets.js";
import { onStart } from "../helpers/flow.js";
import { LocalModelProvider, TestDecisionsProvider } from "../models/providers.fixture.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

/**
 * #263: a child workflow that its application does not list is a workflow of that application all
 * the same — collected transitively, it goes through every application rule a listed one does:
 * names, models, the DI and infrastructure rules; budget coverage only where it matters (a child
 * spends from its root's budgets, so it needs no execution budget of its own).
 */

/** What the application's assembly fails with: its codes and messages. */
async function failureOf(application: Class): Promise<readonly (readonly [string, string])[]> {
  const error: unknown = await applicationOf(application).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof GraphRuleError))
    throw new Error(`expected a GraphRuleError: ${String(error)}`);
  return error.violations.map((found) => [found.code, found.message] as const);
}

const codesOf = async (application: Class): Promise<readonly string[]> =>
  (await failureOf(application)).map(([code]) => code);

let count = 0;

/** A child (one start, one agent, one finish) and its parent, which lists only itself. */
function childAndParent(
  agent: Class,
  options: { readonly providers?: readonly Class[]; readonly finish?: Class } = {},
) {
  count += 1;
  const n = String(count);
  @WorkflowStart({
    name: `rules-child-${n}-workflow-start`,
    description: "A message",
    input: WorkflowStartTextDto,
  })
  class ChildStart {}
  @WorkflowFinish({
    name: `rules-child-${n}-workflow-finish`,
    description: "The answer",
    output: WorkflowFinishTextDto,
  })
  class ChildFinish {}
  @Workflow({
    name: `rules-child-${n}-workflow`,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [
      onStart(ChildStart)
        .toAgent(agent)
        .toFinish(options.finish ?? ChildFinish),
    ],
    ...(options.providers === undefined ? {} : { providers: [...options.providers] }),
  })
  class ChildWorkflow {}
  @WorkflowStart({
    name: `rules-parent-${n}-workflow-start`,
    description: "A message",
    input: WorkflowStartTextDto,
  })
  class ParentStart {}
  @WorkflowFinish({
    name: `rules-parent-${n}-workflow-finish`,
    description: "The answer",
    output: WorkflowFinishTextDto,
  })
  class ParentFinish {}
  @Workflow({
    name: `rules-parent-${n}-workflow`,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [onStart(ParentStart).toWorkflow(ChildWorkflow).toFinish(ParentFinish)],
  })
  class ParentWorkflow {}
  return { ChildWorkflow, ParentWorkflow, ParentFinish };
}

const textAgent = (
  name: string,
  model = "moonshotai/kimi-k2.6",
  tools: readonly ToolHandlerClass[] = [],
  modelProvider?: Class,
): Class => {
  @Agent({
    name,
    description: "Answers",
    prompt: inline("Answer."),
    model,
    tools: [...tools],
    ...(modelProvider === undefined ? {} : { modelProvider }),
  })
  class TextAgent {}
  return TextAgent;
};

const applicationOfParent = (
  parent: Class,
  extra: { readonly providers?: readonly Class[] } = {},
): Class => {
  count += 1;
  @Application({
    name: `rules-${String(count)}-application`,
    modelProvider: TestModelProvider,
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [parent],
    budgets: TEST_BUDGETS,
    ...(extra.providers === undefined ? {} : { providers: [...extra.providers] }),
  })
  class RulesApplication {}
  return RulesApplication;
};

describe("#263: an unlisted child goes through the application's rules", () => {
  it("[name.kind-suffix]: a child's component named without its kind", async () => {
    const { ParentWorkflow } = childAndParent(textAgent("child-helper"));

    expect(await codesOf(applicationOfParent(ParentWorkflow))).toContain("name.kind-suffix");
  });

  it("[graph.duplicate-node-name]: a child's component with the name of another class of the parent", async () => {
    @WorkflowFinish({
      name: "rules-shared-workflow-finish",
      description: "The answer",
      output: WorkflowFinishTextDto,
    })
    class ChildSharedFinish {}
    const { ParentWorkflow } = childAndParent(textAgent("rules-dup-helper-agent"), {
      finish: ChildSharedFinish,
    });
    @WorkflowStart({
      name: "rules-other-workflow-start",
      description: "A message",
      input: WorkflowStartTextDto,
    })
    class OtherStart {}
    @WorkflowFinish({
      name: "rules-shared-workflow-finish",
      description: "Another answer",
      output: WorkflowFinishTextDto,
    })
    class OtherSharedFinish {}
    @Workflow({
      name: "rules-other-workflow",
      version: "1.0.0",
      historyTtl: Ttl.Forever,
      flow: [onStart(OtherStart).toWorkflow(ParentWorkflow).toFinish(OtherSharedFinish)],
    })
    class OtherWorkflow {}

    expect(await codesOf(applicationOfParent(OtherWorkflow))).toContain(
      "graph.duplicate-node-name",
    );
  });

  it("[di.infrastructure-in-workflow]: infrastructure in an unlisted child's providers", async () => {
    const { ParentWorkflow } = childAndParent(textAgent("rules-misplaced-agent"), {
      providers: [LocalModelProvider],
    });

    expect(await failureOf(applicationOfParent(ParentWorkflow))).toContainEqual([
      "di.infrastructure-in-workflow",
      expect.stringContaining("LocalModelProvider is a @ModelProvider"),
    ]);
  });

  it("[model.incompatible-provider]: a child's chat agent names a decisions provider", async () => {
    const { ParentWorkflow } = childAndParent(
      textAgent("rules-twice-agent", "local/llama", [], TestDecisionsProvider),
    );

    const failure = await failureOf(
      applicationOfParent(ParentWorkflow, { providers: [TestDecisionsProvider] }),
    );

    expect(failure).toContainEqual([
      "model.incompatible-provider",
      expect.stringMatching(/local\/llama.*decisions-model-provider does not serve chat models/),
    ]);
  });

  it("[model.missing-provider]: a child's agent with no provider in its cascade, when the application names none", async () => {
    const { ParentWorkflow } = childAndParent(textAgent("rules-bare-agent", "local/llama"));
    count += 1;
    @Application({
      name: `rules-${String(count)}-application`,
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [ParentWorkflow],
      budgets: TEST_BUDGETS,
    })
    class BareApplication {}

    expect(await failureOf(BareApplication)).toContainEqual([
      "model.missing-provider",
      expect.stringContaining("agents.rules-bare-agent = local/llama"),
    ]);
  });

  it("a child's dependency nobody provides fails the assembly, naming it", async () => {
    // undecorated: a decorated class is found through `deps` (#1324), a bare one cannot be created
    class UnprovidedLookupService {
      readonly kind = "unprovided";
    }
    class LookupDto {
      @Text({ prompt: "what to look up" })
      text!: string;
    }
    @Tool({
      name: "rules-lookup-tool",
      description: "Looks up",
      input: LookupDto,
      output: LookupDto,
      deps: [UnprovidedLookupService],
    })
    class LookupTool {
      constructor(readonly service: UnprovidedLookupService) {}
      execute(input: LookupDto): Promise<LookupDto> {
        return Promise.resolve(input);
      }
    }
    const { ParentWorkflow } = childAndParent(
      textAgent("rules-lookup-agent", "moonshotai/kimi-k2.6", [LookupTool]),
    );

    await expect(applicationOf(applicationOfParent(ParentWorkflow))).rejects.toThrow(
      '"UnprovidedLookupService" is not registered',
    );
  });

  it("budgets: the child needs no execution budget of its own — it spends from its root's", async () => {
    const { ParentWorkflow } = childAndParent(textAgent("rules-budgeted-agent"));
    @Budget({
      name: "rules-parent-execution-budget",
      scope: BudgetScope.Execution,
      workflow: ParentWorkflow,
    })
    class ParentExecutionBudget implements BudgetHandler {
      maxSpend(): Usd {
        return usd(1);
      }
    }
    @Application({
      name: "rules-budgeted-application",
      modelProvider: TestModelProvider,
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [ParentWorkflow],
      budgets: [TestApplicationDailyBudget, TestTenantDailyBudget, ParentExecutionBudget],
    })
    class BudgetedApplication {}

    const assembled = await applicationOf(BudgetedApplication);

    expect(assembled.workflows.map((workflow) => workflow.config.name)).toHaveLength(2);
  });
});
