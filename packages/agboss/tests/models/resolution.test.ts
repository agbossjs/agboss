/**
 * #266 AC2: every `model` of the application (agents, model routers, the default router, guards,
 * compaction, judges) resolves to exactly one of its model providers by `serves` — none →
 * `[model.unserved]`, two → `[model.ambiguous-provider]`, all at once at assembly; `agboss describe`
 * prints `model → provider` next to each.
 */
import { describe, expect, it } from "vitest";
import { createApp, describeWorkflow, GraphRuleError } from "../../src/index.js";
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
  if (!(error instanceof GraphRuleError)) throw new Error(`expected a GraphRuleError: ${String(error)}`);
  return error.violations.map((found) => [found.code, found.message] as const);
}

const unserved = (key: string, model: string, purpose = "chat"): readonly [string, string] => [
  "model.unserved",
  `every-kind-workflow ${key} = ${model}: no listed provider serves it for ${purpose} (listed: local) — list a @ModelProvider that serves it in @Application({ providers })`,
];

describe("#266 AC2: every model resolves to exactly one provider by serves", () => {
  it("unserved: a model no listed provider serves fails the assembly, naming the workflow, the key and the model", async () => {
    const violations = await violationsOf(EveryKindApplication);

    expect(violations).toContainEqual(unserved("agents.nowhere-agent", "nowhere/agent"));
  });

  it("ambiguous: two listed providers serving one model fail the assembly — none is preferred", async () => {
    expect(await violationsOf(MirroredApplication)).toEqual([
      [
        "model.ambiguous-provider",
        "local-workflow agents.local-agent = local/llama: served by several providers: local, local-mirror — one model string per provider, each in one serves",
      ],
    ]);
  });

  it("every model kind: agents, model routers, the default router, guards, compaction and judges — all at once", async () => {
    expect(await violationsOf(EveryKindApplication)).toEqual([
      unserved("agents.nowhere-agent", "nowhere/agent"),
      unserved("compaction", "nowhere/compaction"),
      unserved("judges.nowhere-judge", "nowhere/judge"),
      unserved("defaults.router", "nowhere/default-router"),
      unserved("guards.input.prompt_injection", "nowhere/guardrail"),
      unserved("routers.nowhere-router", "nowhere/router"),
    ]);
  });

  it("createApp fails before any model call with the same violations", async () => {
    await expect(createApp(EveryKindApplication)).rejects.toThrow("[model.unserved]");
  });

  it("describe prints model → provider for each model, though no component names one", async () => {
    const [workflow] = (await applicationOf(BuiltInApplication)).workflows;
    if (workflow === undefined) throw new Error("the application has a workflow");

    const lines = describeWorkflow(workflow);

    expect(lines.slice(lines.indexOf("models"), lines.indexOf("agents"))).toEqual([
      "models",
      "  agents.local-agent  model: local/llama → openrouter",
      "  defaults.router  model: typesafe/jev-1.13 → decisions",
    ]);
  });
});
