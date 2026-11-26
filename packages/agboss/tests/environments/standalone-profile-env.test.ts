/**
 * #1324b (review 1426 H2): a command that builds one workflow on its own (studio, replay, golden,
 * eval score, compare) resolves `defineEnv` with the selected profile's `configureEnv` values, as
 * `createApp` does; and a variable unset in every layer is `[environment.missing-variable]` there —
 * only `agboss check` and `describe` defer it (H1).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { createAppDeps } from "../../src/app/app-deps.js";
import { studioOf } from "../../src/studio.js";
import { compareBundleProfiles } from "../../src/eval/compare-profiles.js";
import { built, PingApplication } from "./fixtures/profile-env/profile-env.application.js";

const workflowOn = async (profile: string | undefined) => {
  const assembled = await applicationOf(PingApplication, { profile }, "test");
  const [workflow] = assembled.workflows;
  if (workflow === undefined) throw new Error("no workflow");
  return workflow;
};

beforeEach(() => {
  built.length = 0;
});

describe("a workflow built on its own reads the profile's configureEnv", () => {
  it("createAppDeps: the staging profile's address, not the dev default", async () => {
    const deps = await createAppDeps(await workflowOn("staging"), { processEnv: {} });
    await deps.close();

    expect(built).toEqual(["https://staging.example"]);
  });

  it("a test profile never pulls the dev address: the profile wins over the process's variable", async () => {
    const deps = await createAppDeps(await workflowOn("staging"), {
      processEnv: { PROFILE_ENV_UPSTREAM: "https://dev-from-process.example" },
    });
    await deps.close();

    expect(built).toEqual(["https://staging.example"]);
  });

  it("studioOf takes the profile too", async () => {
    const studio = await studioOf(PingApplication, { profile: "staging", processEnv: {} });
    await studio.close();

    expect(built).toEqual(["https://staging.example"]);
  });

  it("compare: profiles that differ only in configureEnv build different tools", async () => {
    await compareBundleProfiles(
      (profile) => workflowOn(profile === "base" ? undefined : profile),
      ["base", "staging"],
      { processEnv: { PROFILE_ENV_REQUIRED: "from-process" } },
      () => Promise.resolve([]),
    );

    expect([...built].sort()).toEqual(["https://dev.example", "https://staging.example"]);
  });

  it("an unset required variable no layer gives fails strictly, naming it", async () => {
    await expect(createAppDeps(await workflowOn(undefined), { processEnv: {} })).rejects.toThrow(
      /\[environment\.missing-variable\] PROFILE_ENV_REQUIRED is not set/,
    );
  });
});
