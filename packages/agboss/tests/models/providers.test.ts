/**
 * #266 AC1: `@ModelProvider` classes are listed only in `@Application({ providers })`; a workflow has
 * no provider setting; none listed → the built-in OpenRouter + Decisions providers, one listed → the
 * list is complete.
 */
import { describe, expect, it } from "vitest";
import { GraphRuleError, WorkflowSettings } from "../../src/index.js";
import { applicationOf } from "../../src/application/assemble.js";
import type { Class } from "../../src/components/injection.js";
import { DecisionsModelProvider, OpenRouterModelProvider } from "../../src/models/index.js";
import { DEFAULT_MODEL_PROVIDERS } from "../../src/models/workflow-models.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { LocalModelProvider } from "./providers.fixture.js";
import {
  BuiltInApplication,
  LocalAgent,
  LocalOnlyApplication,
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

  it("built-ins when none listed: OpenRouter for chat, the Decisions API for Jev", async () => {
    const { workflows } = await applicationOf(BuiltInApplication);

    expect(workflows.map((workflow) => workflow.modelProviders)).toEqual([DEFAULT_MODEL_PROVIDERS]);
    expect(DEFAULT_MODEL_PROVIDERS).toEqual([OpenRouterModelProvider, DecisionsModelProvider]);
  });

  it("a listed set is complete: the built-ins are not added next to it", async () => {
    expect(await violationsOf(LocalOnlyApplication)).toEqual([
      "[model.unserved] local-workflow defaults.router = typesafe/jev-1.13: no listed provider serves it for decision (listed: local) — list a @ModelProvider that serves it in @Application({ providers })",
    ]);
  });

  it("a listed set is complete: the workflows get exactly the listed providers, the container none", async () => {
    const { workflows, modules } = await applicationOf(MemoryDeskApplication);

    expect(workflows.map((workflow) => workflow.modelProviders)).toEqual([
      [DecisionsModelProvider, LocalModelProvider],
    ]);
    expect(modules.flatMap((module) => module.providers)).not.toContain(LocalModelProvider);
  });
});

describe("#266 AC1: an application's model providers serve its executions", () => {
  const test = testWith(BuiltInApplication);

  test("a workflow of an application listing none runs on the built-ins (scripted)", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(LocalAgent).thenReturn(replyWith("hello"));

    const result = await execute(app, LocalStart, { text: "hi" });

    expect(result.output).toEqual({ text: "hello" });
  });
});
