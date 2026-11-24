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
  });

  it("refuses a key it does not have, and a wrong value", () => {
    const hot = { temperature: "hot" } as const;
    // @ts-expect-error -- budgets are a shelf of #1318d2, not a key yet
    defineConfig({ budgets: {} });
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
