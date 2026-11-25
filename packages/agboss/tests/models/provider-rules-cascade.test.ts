/**
 * #1313a: the provider rules (timeout, price, breaker, mode) run for every provider a cascade names —
 * the application's, a workflow's, an agent's — not only the listed ones; and `describe` lists them.
 */
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { describedApplicationOf } from "../../src/describe/application.js";
import { describeAssembledApplication } from "../../src/describe/describe-application.js";
import type { Class } from "../../src/components/injection.js";
import {
  BrokenAgentApplication,
  BrokenAppLevelApplication,
  BrokenWorkflowApplication,
  NamedApplication,
  SoundApplication,
} from "./fixtures/cascade-rules.workflow.js";

async function codesOf(application: Class): Promise<string[]> {
  const error: unknown = await applicationOf(application).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof ConfigError.GraphRules))
    throw new Error(`expected a ConfigError.GraphRules: ${String(error)}`);
  return error.violations.map((found) => found.code).sort();
}

describe("#1313a: the provider rules reach every provider a cascade names", () => {
  it.each([
    ["the application's modelProvider", BrokenAppLevelApplication],
    ["a workflow's modelProvider", BrokenWorkflowApplication],
    ["an agent's modelProvider", BrokenAgentApplication],
  ])("%s: a wrong price and a timeout past the maximum fail the assembly", async (_level, app) => {
    expect(await codesOf(app)).toEqual(
      expect.arrayContaining(["limits.timeout-invalid", "model.price-invalid"]),
    );
  });

  it("sound providers named at the same levels assemble", async () => {
    await expect(applicationOf(SoundApplication)).resolves.toBeDefined();
    await expect(applicationOf(NamedApplication)).resolves.toBeDefined();
  });
});

describe("#1313a: describe lists the providers a cascade names", () => {
  it("the application's, the workflow's and the agent's, each as named by modelProvider", async () => {
    const assembled = await applicationOf(NamedApplication);
    const described = describedApplicationOf(assembled);

    expect(described.modelProviders.map((provider) => [provider.name, provider.isNamed])).toEqual([
      ["second-models", true],
      ["sound-models", true],
      ["third-models", true],
    ]);
    const text = describeAssembledApplication(assembled).join("\n");
    expect(text).toContain("second-models → SecondModels (named by modelProvider)");
    expect(text).toContain("third-models → ThirdModels (named by modelProvider)");
  });
});
