/**
 * #266 AC1: `@ModelProvider` classes are listed only in `@Application({ providers })`; a workflow has
 * no provider setting; none listed → the built-in OpenRouter + Decisions providers, one listed → the
 * list is complete.
 */
import { describe, expect, it } from "vitest";
import { GraphRuleError, WorkflowSettings } from "../../src/index.js";
import { applicationOf } from "../../src/application/assemble.js";
import type { Class } from "../../src/components/injection.js";
import {} from "../../src/models/index.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  LocalModelProvider,
  TestDecisionsProvider,
  TestOpenRouterProvider,
} from "./providers.fixture.js";
import {
  BuiltInApplication,
  LocalAgent,
  EveryKindApplication,
  LocalStart,
  MisplacedProviderApplication,
} from "./fixtures/resolution.workflow.js";
import { MemoryDeskApplication } from "../memory/fixtures/memory.workflow.js";

/** The rule violations the application's assembly fails with, as `[code] message`. */
async function violationsOf(application: Class): Promise<string[]> {
  const error: unknown = await applicationOf(application).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof GraphRuleError))
    throw new Error(`expected a GraphRuleError: ${String(error)}`);
  return error.violations.map((found) => `[${found.code}] ${found.message}`);
}

describe("#266 AC1: model providers are the application's infrastructure", () => {
  it("only in @Application: a @ModelProvider in a workflow's providers is di.infrastructure-in-workflow", async () => {
    expect(await violationsOf(MisplacedProviderApplication)).toEqual([
      "[di.infrastructure-in-workflow] LocalModelProvider is a @ModelProvider — infrastructure is listed only in @Application({ providers }), not in misplaced-provider-workflow's providers",
    ]);
  });

  it("only in @Application: a workflow's settings have no provider setting", () => {
    const builder = WorkflowSettings.builder();

    // @ts-expect-error -- a workflow names models only: no modelProviders in its settings (#266)
    expect(builder.modelProviders).toBeUndefined();
    // @ts-expect-error -- and no default provider to break a tie
    expect(builder.defaultModelProvider).toBeUndefined();
  });

  it("no provider listed: no built-ins either — only the providers a model names are the workflow's", async () => {
    const { workflows } = await applicationOf(BuiltInApplication);

    expect(workflows.map((workflow) => workflow.modelProviders)).toEqual([[LocalModelProvider]]);
  });

  it("a model with no modelProvider anywhere is [model.missing-provider], whatever its name", async () => {
    expect((await violationsOf(EveryKindApplication)).map((line) => line.slice(0, 24))).toContain(
      "[model.missing-provider]",
    );
  });

  it("a listed set is complete: the workflows get exactly the listed providers, the container none", async () => {
    const { workflows, modules } = await applicationOf(MemoryDeskApplication);

    expect(workflows.map((workflow) => workflow.modelProviders)).toEqual([
      [TestDecisionsProvider, LocalModelProvider],
    ]);
    expect(modules.flatMap((module) => module.providers)).not.toContain(LocalModelProvider);
  });
});

describe("#266 AC1: an application's model providers serve its executions", () => {
  const test = testWith(BuiltInApplication);

  test("a workflow whose agent names a provider the application does not list runs on it (scripted)", async ({
    app,
    mockModel,
  }) => {
    mockModel(LocalAgent).thenReturn(replyWith("hello"));

    const result = await execute(app, LocalStart, { text: "hi" });

    expect(result.output).toEqual({ text: "hello" });
  });
});
