import { describe, expectTypeOf, it } from "vitest";
import type * as Internal from "../../src/internal.js";
import {
  configureEnv,
  defineConfig,
  defineEnv,
  env,
  type ConfigOverlay,
  type ConfigSpec,
  type ProfileSelection,
  type WorkflowConfig,
} from "../../src/index.js";
import type { TestWithOptions } from "../../src/testing/environment.js";
import { usd } from "../../src/units/index.js";
import { ConfigModels } from "./fixtures/ts-app/ts.application.js";

const appEnv = defineEnv({ region: env("REGION", { default: "eu" }) });

describe("#1318d1: defineConfig", () => {
  it("takes a ConfigSpec and returns the frozen profile a .config.ts exports", () => {
    expectTypeOf(defineConfig).parameter(0).toEqualTypeOf<ConfigSpec>();
    expectTypeOf(defineConfig).returns.toEqualTypeOf<ConfigOverlay>();
  });

  it("holds constants, defineEnv overrides and the application's replaceable classes", () => {
    expectTypeOf(
      defineConfig({
        env: configureEnv(appEnv, { region: "us" }),
        modelProviders: { "config-models": { models: { fast: "x/fast" } } },
        workflows: {
          "*": { version: "2.0.0" },
          "a-workflow": {
            agents: { "a-agent": { temperature: 0 } },
            prompts: { "a-agent": "./a.md" },
          },
        },
        modelProvider: ConfigModels,
      }),
    ).toEqualTypeOf<ConfigOverlay>();
    expectTypeOf<WorkflowConfig>().toHaveProperty("modelProvider");
    expectTypeOf<WorkflowConfig>().toHaveProperty("memories");
    expectTypeOf<WorkflowConfig>().toHaveProperty("routers");
    expectTypeOf<WorkflowConfig>().not.toHaveProperty("defaults");
    expectTypeOf<WorkflowConfig>().not.toHaveProperty("compactions");
    expectTypeOf(
      defineConfig({
        budgets: { "a-budget": { maxSpend: usd(1), maxTokens: 10 } },
        judges: { "a-judge": { model: "fast", modelProvider: ConfigModels } },
        guardrails: { "a-guardrail": { modelProvider: "config-models" } },
      }),
    ).toEqualTypeOf<ConfigOverlay>();
  });

  it("refuses a key it does not have, and a wrong value", () => {
    const hot = { temperature: "hot" } as const;
    // @ts-expect-error -- a shelf nobody has is no key
    defineConfig({ servers: {} });
    // @ts-expect-error -- #1318c: a workflow's `compactions` are its `memories`
    defineConfig({ workflows: { "a-workflow": { compactions: {} } } });
    // @ts-expect-error -- #1318c: chat defaults are app-wide (`defaults`), not a workflow's overlay
    defineConfig({ workflows: { "a-workflow": { defaults: {} } } });
    // @ts-expect-error -- a budget takes a limit, not a name or a flag
    defineConfig({ budgets: { "a-budget": { maxSpend: "5" } } });
    // @ts-expect-error -- a temperature is a number
    defineConfig({ workflows: { "a-workflow": { agents: { "a-agent": hot } } } });
    // @ts-expect-error -- configureEnv values are by the keys of its defineEnv
    configureEnv(appEnv, { nope: 1 });
  });

  it("a profile selection is one text, a comma or plus list, or a list of names", () => {
    expectTypeOf<ProfileSelection>().toEqualTypeOf<string | readonly string[]>();
    expectTypeOf<TestWithOptions["profile"]>().toEqualTypeOf<ProfileSelection | undefined>();
  });

  it("profileRoot, the per-workflow profile loader and the profile schema are gone", () => {
    // @ts-expect-error -- profiles are found next to the application file, not under a root
    const options: TestWithOptions = { profileRoot: "." };
    expectTypeOf(options).toBeObject();
    expectTypeOf<typeof Internal>().not.toHaveProperty("withProfile");
    expectTypeOf<typeof Internal>().toHaveProperty("ProfileError");
  });
});
