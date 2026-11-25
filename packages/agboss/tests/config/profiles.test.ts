/** #1318d1: `defineConfig`, the profile selection, the layering and what a `.config.ts` changes. */
import { describe, expect, it } from "vitest";
import { createApp, defineConfig } from "../../src/index.js";
import { deepMerge } from "../../src/config/deep-merge.js";
import { ProfileError, ProfileErrorReason } from "../../src/config/profile-error.js";
import {
  APP_DEFAULT_PROFILE,
  selectedProfilesOf,
  TEST_DEFAULT_PROFILE,
} from "../../src/config/profile-names.js";
import { applicationOf } from "../../src/application/assemble.js";
import { TestEnvironment } from "../../src/testing/environment.js";
import { RegionService, TsApplication } from "./fixtures/ts-app/ts.application.js";
import { appEnv } from "./fixtures/ts-app/app.env.js";

const failure = async (attempt: Promise<unknown>): Promise<ProfileError> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof ProfileError) return error;
    throw error;
  }
  throw new Error("expected a ProfileError");
};

describe("profile selection", () => {
  it("names the default when none is given, and says it was not asked for", () => {
    expect(selectedProfilesOf(undefined, APP_DEFAULT_PROFILE)).toEqual({
      names: ["dev"],
      isExplicit: false,
    });
    expect(selectedProfilesOf(undefined, TEST_DEFAULT_PROFILE).names).toEqual(["test"]);
  });

  it.each([
    ["prod", ["prod"]],
    ["prod,economy", ["prod", "economy"]],
    ["prod+economy", ["prod", "economy"]],
    [" prod , economy ", ["prod", "economy"]],
    [
      ["prod", "economy"],
      ["prod", "economy"],
    ],
    [
      ["prod,economy", "eu"],
      ["prod", "economy", "eu"],
    ],
  ])("splits %j into %j, in order", (selection, names) => {
    expect(selectedProfilesOf(selection, "dev")).toEqual({ names, isExplicit: true });
  });

  it.each([[""], ["prod,"], [",prod"], ["Prod"], ["a b"], ["a_b"], ["../x"], ["a,a"], [[]]])(
    "%j is BadName",
    (selection) => {
      expect(() => selectedProfilesOf(selection, "dev")).toThrow(ProfileError);
      try {
        selectedProfilesOf(selection, "dev");
      } catch (error) {
        expect((error as ProfileError).reason).toBe(ProfileErrorReason.BadName);
      }
    },
  );
});

describe("deepMerge", () => {
  it("objects merge key by key, arrays and scalars replace", () => {
    expect(
      deepMerge({ a: { x: 1, y: 2 }, list: [1, 2], s: "a" }, { a: { y: 3 }, list: [9], s: "b" }),
    ).toEqual({ a: { x: 1, y: 3 }, list: [9], s: "b" });
  });
});

describe("defineConfig", () => {
  it("returns a frozen profile that holds what it was given", () => {
    const config = defineConfig({ defaults: { uncompactedTurns: 3 } });

    expect(config.defaults).toEqual({ uncompactedTurns: 3 });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("fails on a typo in a key, naming the path", () => {
    expect(() => defineConfig({ budgetz: {} } as never)).toThrow(/defineConfig: .*budgetz/);
  });

  it("fails on a wrong value with its path, never the value", () => {
    const wrong = {
      workflows: { "w-workflow": { agents: { "a-agent": { temperature: "hot-secret-value" } } } },
    };
    let message = "";
    try {
      defineConfig(wrong as never);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/workflows\.w-workflow\.agents\.a-agent\.temperature/);
    expect(message).not.toContain("hot-secret-value");
  });

  it("takes configureEnv values for env, not an ad-hoc object", () => {
    expect(() => defineConfig({ env: { contract: {}, values: {} } } as never)).toThrow(
      /configureEnv/,
    );
  });

  it("takes a @ModelProvider class for modelProvider", () => {
    expect(() =>
      defineConfig({
        modelProvider: class NoProvider {
          readonly kind = "no-provider";
        },
      }),
    ).toThrow(/@ModelProvider/);
  });
});

describe("a .config.ts profile", () => {
  const withProfile = (profile?: string | readonly string[]) =>
    TestEnvironment.of(TsApplication, profile === undefined ? {} : { profile });

  it("resolves a provider's role to a new model name, before the cascade", async () => {
    const base = await withProfile();
    const staging = await withProfile("staging");

    expect(base.assembled.workflows[0]?.config.agents["ts-agent"]?.model).toBe("base/fast");
    expect(staging.assembled.workflows[0]?.config.agents["ts-agent"]?.model).toBe("staging/fast");
    expect(staging.assembled.workflows[0]?.config.agents["ts-agent"]?.temperature).toBe(0);
  });

  it("a provider overlay changes the options of this assembly, never the declaration", async () => {
    await withProfile("staging");
    const base = await withProfile();

    expect(base.assembled.workflows[0]?.config.agents["ts-agent"]?.model).toBe("base/fast");
  });

  it("a later profile wins per model name, an earlier one's other names stay", async () => {
    const both = await withProfile("staging,economy");

    // economy changes the default role, staging the fast one: both stand
    expect(both.assembled.workflows[0]?.config.agents["ts-agent"]?.model).toBe("staging/fast");
    expect(both.assembled.profiles).toEqual(["staging", "economy"]);
  });

  it("replaces the application's provider whole", async () => {
    const swapped = await withProfile("swap");

    expect(swapped.assembled.workflows[0]?.config.agents["ts-agent"]?.model).toBe("other/fast");
  });

  it("configureEnv gives a defineEnv key its value in place of the process's", async () => {
    const environment = await TestEnvironment.of(TsApplication, { profile: "staging" });
    const built = await environment.newApp();
    const service = built.app.resolve(RegionService);

    expect(service.config.region).toBe("us");
    expect(service.config.apiKey).toBeUndefined();
  });

  it("a configureEnv of two profiles merges per key, a later profile winning", async () => {
    const environment = await TestEnvironment.of(TsApplication, { profile: "staging,economy" });
    const built = await environment.newApp();
    const { config } = built.app.resolve(RegionService);

    expect(config.region).toBe("us");
    expect(config.retries).toBe(1);
    expect(config.apiKey).toBeUndefined();
    expect(appEnv).toBeDefined();
  });

  it("without a profile that sets env, defineEnv reads the process as it always did", async () => {
    const environment = await TestEnvironment.of(TsApplication, {});
    const built = await environment.newApp();

    expect(built.app.resolve(RegionService).config.region).toBe("eu");
  });

  it("names a profile that exists as a layer in createApp's default too: dev has no file, no layer", async () => {
    const assembled = await applicationOf(TsApplication, {});

    expect(assembled.profiles).toEqual(["dev"]);
    expect(assembled.envOverrides).toEqual([]);
  });

  it("an unknown provider in modelProviders is Unknown, listing the ones the application has", async () => {
    const error = await failure(withProfile("ghost-provider"));

    expect(error.reason).toBe(ProfileErrorReason.Unknown);
    expect(error.message).toMatch(
      /modelProviders\.ghost-models: no such model provider.*config-models/,
    );
  });

  it("a file that exports no defineConfig is Invalid", async () => {
    const error = await failure(withProfile("not-defined"));

    expect(error.reason).toBe(ProfileErrorReason.Invalid);
    expect(error.message).toMatch(/not-defined\.config\.ts: must export default defineConfig/);
  });

  it("a typo, a wrong value and a non-provider class fail at load, naming the file", async () => {
    expect((await failure(withProfile("typo"))).message).toMatch(/typo\.config\.ts: .*budgetz/);
    const wrong = await failure(withProfile("wrong-value"));
    expect(wrong.message).toMatch(/wrong-value\.config\.ts: .*temperature/);
    expect(wrong.message).not.toContain("hot-secret-value");
    expect((await failure(withProfile("not-a-provider"))).message).toMatch(/@ModelProvider/);
    expect((await failure(withProfile("ts-env"))).message).toMatch(/configureEnv/);
  });

  it("createApp takes the same profile", async () => {
    await expect(createApp(TsApplication, { profile: "nope" })).rejects.toBeInstanceOf(
      ProfileError,
    );
  });
});
