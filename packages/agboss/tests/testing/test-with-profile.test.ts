/**
 * #895 D1 → #1318d1: `testWith(App, { profile })` — an application under profiles in a test, as
 * `createApp(App, { profile })` runs it (`src/config/<name>.config.ts|yaml` next to the application
 * file, over `base.config.*`), with the test seams (scripted models, no keys).
 */
import { describe, expect, it } from "vitest";
import { createApp, type AgentsConfigOf } from "../../src/index.js";
import { ProfileError, ProfileErrorReason } from "../../src/config/profile-error.js";
import { TestEnvironment } from "../../src/testing/environment.js";
import { testWith, type TestApp } from "../../src/testing/index.js";
import { ProfileApplication } from "./fixtures/profile-app/profile.application.js";

const settingsOf = (app: TestApp, workflow: string): AgentsConfigOf<string> => {
  const found = app.settings[workflow];
  if (found === undefined) throw new Error(`no settings of ${workflow}`);
  return found;
};

const reasonOf = async (attempt: Promise<unknown>): Promise<ProfileErrorReason | undefined> => {
  try {
    await attempt;
  } catch (error) {
    return error instanceof ProfileError ? error.reason : undefined;
  }
  return undefined;
};

describe("#1318d1: testWith applies a profile", () => {
  const lowThinking = testWith(ProfileApplication, { profile: "low-thinking" });

  lowThinking("the resolved settings show thinking low and the profile's version", ({ app }) => {
    const kidSettings = settingsOf(app, "profile-kid-workflow");

    expect(kidSettings.agents["kid-agent"]?.thinking).toBe("low");
    expect(kidSettings.version).toBe("1.0.0-low-thinking");
    expect(settingsOf(app, "profile-boss-workflow").agents["boss-agent"]?.thinking).toBeUndefined();
  });

  lowThinking("a child workflow the application does not list gets it too", ({ app }) => {
    expect(Object.keys(app.settings).sort()).toEqual([
      "profile-boss-workflow",
      "profile-kid-workflow",
    ]);
    expect(Object.values(app.settings).map((one) => one.version)).toEqual([
      "1.0.0-low-thinking",
      "1.0.0-low-thinking",
    ]);
  });

  testWith(ProfileApplication)(
    "no profile — the test profile has no file, the base settings",
    ({ app }) => {
      expect(settingsOf(app, "profile-kid-workflow").agents["kid-agent"]?.thinking).toBeUndefined();
      expect(settingsOf(app, "profile-kid-workflow").version).toBe("1.0.0");
    },
  );

  testWith(ProfileApplication, { profile: "base" })(
    "the profile base is base.config alone",
    ({ app }) => {
      // base.config.yaml: defaults.models.temperature 0.5 on every workflow
      expect(settingsOf(app, "profile-kid-workflow").defaults.models.temperature).toBe(0.5);
      expect(settingsOf(app, "profile-kid-workflow").version).toBe("1.0.0");
    },
  );

  it("settings is read-only", () => {
    const readOnly = (app: TestApp): void => {
      // @ts-expect-error -- a test reads what was applied; it does not set it
      app.settings = {};
    };
    expect(readOnly).toBeTypeOf("function");
  });
});

describe("#1318d1: profiles layer left to right over base", () => {
  const layered = (profile: string | readonly string[]) =>
    TestEnvironment.of(ProfileApplication, { profile }).then(
      (environment) =>
        environment.assembled.workflows.find((one) => one.config.name === "profile-kid-workflow")
          ?.config,
    );

  it("a later profile wins per key, an earlier one's other keys stay, base is under both", async () => {
    const config = await layered("low-thinking,economy");

    expect(config?.agents["kid-agent"]?.thinking).toBe("high");
    expect(config?.agents["kid-agent"]?.temperature).toBe(0.2);
    expect(config?.defaults.uncompactedTurns).toBe(2);
    expect(config?.defaults.models.temperature).toBe(0.5);
    // economy is later: its "*" version wins over low-thinking's own
    expect(config?.version).toBe("1.0.0-economy");
  });

  it("the order is the order given: economy then low-thinking ends on low", async () => {
    const config = await layered(["economy", "low-thinking"]);

    expect(config?.agents["kid-agent"]?.thinking).toBe("low");
    expect(config?.agents["kid-agent"]?.temperature).toBe(0.2);
    expect(config?.version).toBe("1.0.0-low-thinking");
  });

  it("+ and , separate profiles alike", async () => {
    expect((await layered("low-thinking+economy"))?.agents["kid-agent"]?.thinking).toBe("high");
    expect((await layered(["low-thinking", "economy"]))?.agents["kid-agent"]?.thinking).toBe(
      "high",
    );
  });

  it("the application's context lists the profiles in layering order", async () => {
    const environment = await TestEnvironment.of(ProfileApplication, {
      profile: "low-thinking,economy",
    });

    expect(environment.assembled.profiles).toEqual(["low-thinking", "economy"]);
  });

  it("a prompt override replaces the declared prompt of that agent only", async () => {
    const environment = await TestEnvironment.of(ProfileApplication, { profile: "terse" });
    const kid = environment.assembled.workflows.find(
      (one) => one.config.name === "profile-kid-workflow",
    );
    const boss = environment.assembled.workflows.find(
      (one) => one.config.name === "profile-boss-workflow",
    );

    expect(kid?.prompts["kid-agent"]).toBe("Answer in one line.");
    expect(boss?.prompts).toEqual({});
  });
});

describe("#1318d1: a profile that fails closed", () => {
  const message = /no profile "nope" in .*config — available: /;

  it("an unknown profile is a ProfileError (Unknown) listing the ones that exist, in testWith", async () => {
    const failure = TestEnvironment.of(ProfileApplication, { profile: "nope" });

    await expect(failure).rejects.toBeInstanceOf(ProfileError);
    await expect(failure).rejects.toThrow(message);
    expect(await reasonOf(TestEnvironment.of(ProfileApplication, { profile: "nope" }))).toBe(
      ProfileErrorReason.Unknown,
    );
  });

  it("createApp says the same", async () => {
    await expect(createApp(ProfileApplication, { profile: "nope" })).rejects.toThrow(message);
  });

  it("one unknown among known ones fails the whole selection", async () => {
    await expect(
      TestEnvironment.of(ProfileApplication, { profile: ["low-thinking", "nope"] }),
    ).rejects.toThrow(/no profile "nope"/);
  });

  it("<name>.config.ts and <name>.config.yaml together are Duplicate", async () => {
    const attempt = TestEnvironment.of(ProfileApplication, { profile: "dup" });

    await expect(attempt).rejects.toThrow(/profile "dup" has two files/);
    expect(await reasonOf(TestEnvironment.of(ProfileApplication, { profile: "dup" }))).toBe(
      ProfileErrorReason.Duplicate,
    );
  });

  it.each([
    ["an empty name", "low-thinking,,economy"],
    ["a name that is none", "Low_Thinking"],
    ["a name twice", "economy,economy"],
  ])("%s is BadName", async (_what, profile) => {
    expect(await reasonOf(TestEnvironment.of(ProfileApplication, { profile }))).toBe(
      ProfileErrorReason.BadName,
    );
  });

  it("a typo in a key is Invalid, naming the file and the path, never a value", async () => {
    const attempt = TestEnvironment.of(ProfileApplication, { profile: "typo" });

    await expect(attempt).rejects.toThrow(
      /typo\.config\.yaml: workflows\.profile-kid-workflow\.agents\.kid-agent/,
    );
    expect(await reasonOf(TestEnvironment.of(ProfileApplication, { profile: "typo" }))).toBe(
      ProfileErrorReason.Invalid,
    );
  });

  it("an agent or a workflow the application does not have is Unknown", async () => {
    await expect(
      TestEnvironment.of(ProfileApplication, { profile: "ghost-agent" }),
    ).rejects.toThrow(/workflows\.profile-kid-workflow: unknown agents: ghost-agent/);
    await expect(
      TestEnvironment.of(ProfileApplication, { profile: "ghost-workflow" }),
    ).rejects.toThrow(/no such workflow in the application: ghost-workflow/);
  });

  it("a ${…} in a YAML file is Forbidden: only defineEnv reads the process environment", async () => {
    const attempt = TestEnvironment.of(ProfileApplication, { profile: "interpolated" });

    await expect(attempt).rejects.toThrow(
      /interpolated\.config\.yaml: workflows\.profile-kid-workflow\.prompts\.kid-agent/,
    );
    expect(
      await reasonOf(TestEnvironment.of(ProfileApplication, { profile: "interpolated" })),
    ).toBe(ProfileErrorReason.Forbidden);
  });

  it("a YAML file cannot enable a disabled feature (memory), nor hold classes", async () => {
    expect(
      await reasonOf(TestEnvironment.of(ProfileApplication, { profile: "enable-memory" })),
    ).toBe(ProfileErrorReason.Forbidden);
    expect(await reasonOf(TestEnvironment.of(ProfileApplication, { profile: "yaml-class" }))).toBe(
      ProfileErrorReason.Forbidden,
    );
  });
});

describe("#1318d1: a profile that switches a model to an unserved one", () => {
  const unserved = /\[model\.unserved\] profile-kid-workflow agents\.kid-agent = cloud\/x/;

  it("testWith reports [model.unserved] at assembly, not at the first call", async () => {
    await expect(TestEnvironment.of(ProfileApplication, { profile: "to-cloud" })).rejects.toThrow(
      unserved,
    );
  });

  it("createApp reports it the same way", async () => {
    await expect(createApp(ProfileApplication, { profile: "to-cloud" })).rejects.toThrow(unserved);
  });
});
