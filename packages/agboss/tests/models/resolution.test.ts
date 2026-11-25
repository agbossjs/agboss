/**
 * #266 AC2, after F2: every `model` of the application (agents, model routers, the default router,
 * guards, compaction, judges) resolves to the provider its cascade names (`modelProvider`) — none →
 * `[model.missing-provider]`, all at once at assembly (`serves` and `[model.unserved]` /
 * `[model.ambiguous-provider]` are gone); `agboss describe` prints `model → provider` next to each.
 */
import { describe, expect, it } from "vitest";
import { describeWorkflow } from "../../src/describe/describe-workflow.js";
import { createApp, GraphRuleError } from "../../src/index.js";
import { applicationOf } from "../../src/application/assemble.js";
import type { Class } from "../../src/components/injection.js";
import {
  BuiltInApplication,
  EveryKindApplication,
  MirroredApplication,
} from "./fixtures/resolution.workflow.js";

/** The violations an application's assembly fails with, by code and message. */
async function violationsOf(application: Class): Promise<(readonly [string, string])[]> {
  const error: unknown = await applicationOf(application).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof GraphRuleError))
    throw new Error(`expected a GraphRuleError: ${String(error)}`);
  return error.violations.map((found) => [found.code, found.message] as const);
}

const missing = (key: string, model: string): readonly [string, string] => [
  "model.missing-provider",
  `every-kind-workflow ${key} = ${model}: no modelProvider is set for it — name one on the component, its workflow or its application (listed: local-model-provider) — set modelProvider on the component, its @Workflow or its @Application, and list the provider in @Application({ providers })`,
];

describe("#266 AC2 (F2): every model resolves to the provider its cascade names", () => {
  it("a model with no provider anywhere fails the assembly, naming the workflow, the key and the model", async () => {
    const violations = await violationsOf(EveryKindApplication);

    expect(violations).toContainEqual(missing("agents.nowhere-agent", "nowhere/agent"));
  });

  it("two listed providers never tie: the agent names the local one, and the mirror is only listed", async () => {
    await expect(applicationOf(MirroredApplication)).resolves.toBeDefined();
  });

  it("every model kind: agents, model routers, the default router, guardrails, compaction and judges — all at once", async () => {
    expect((await violationsOf(EveryKindApplication)).map(([code]) => code)).toEqual(
      Array.from({ length: 6 }, () => "model.missing-provider"),
    );
    expect((await violationsOf(EveryKindApplication)).map(([, message]) => message)).toEqual(
      expect.arrayContaining([
        missing("agents.nowhere-agent", "nowhere/agent")[1],
        missing("memories.nowhere-memory", "nowhere/compaction")[1],
      ]),
    );
  });

  it("createApp fails before any model call with the same violations", async () => {
    await expect(createApp(EveryKindApplication)).rejects.toThrow("[model.missing-provider]");
  });

  it("a provider only an agent names is part of the application, listed or not", async () => {
    const { workflows } = await applicationOf(BuiltInApplication);

    expect(workflows.map((workflow) => workflow.modelProviders.map((cls) => cls.name))).toEqual([
      ["LocalModelProvider"],
    ]);
  });

  it("describe prints model → provider for each model", async () => {
    const [workflow] = (await applicationOf(MirroredApplication)).workflows;
    if (workflow === undefined) throw new Error("the application has a workflow");

    const lines = describeWorkflow(workflow);

    expect(lines.slice(lines.indexOf("models"), lines.indexOf("agents"))).toEqual([
      "models",
      "  agents.local-agent  model: local/llama → local-model-provider",
    ]);
  });
});
