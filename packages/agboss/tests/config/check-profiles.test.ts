/** #1318d2: `agboss check` takes every profile of src/config/ — the inactive ones too — schema-only. */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { configJsonSchemaOf } from "../../src/config/config-json-schema.js";
import { profileProblemsOf } from "../../src/config/check-profiles.js";
import { ProfileApplication } from "../testing/fixtures/profile-app/profile.application.js";

describe("every profile of src/config/", () => {
  it("names each broken one with its file, the good ones are not named", async () => {
    const problems = await profileProblemsOf(ProfileApplication, "agboss check");
    const byProfile = new Map(problems.map((one) => [one.profile, one]));

    expect([...byProfile.keys()].sort()).toEqual([
      "dup",
      "enable-memory",
      "ghost-agent",
      "ghost-workflow",
      "interpolated",
      "to-cloud",
      "typo",
      "yaml-class",
    ]);
    expect(byProfile.get("dup")?.message).toMatch(/two files/);
    expect(byProfile.get("typo")?.file).toMatch(/typo\.config\.yaml$/);
    expect(byProfile.get("ghost-workflow")?.message).toMatch(/ghost-workflow/);
  });

  it("needs no variable and no secret: the process environment is not read", async () => {
    const before = { ...process.env };
    await profileProblemsOf(ProfileApplication, "agboss check");

    expect(process.env).toEqual(before);
  });
});

describe("the project's JSON Schema of a .config.yaml", () => {
  it("names the workflows, their agents and `*`, and refuses other keys", async () => {
    const schema = configJsonSchemaOf(await applicationOf(ProfileApplication));
    const workflows = (schema.properties as Record<string, any>).workflows;

    expect(Object.keys(workflows.properties).sort()).toEqual([
      "*",
      "profile-boss-workflow",
      "profile-kid-workflow",
    ]);
    expect(
      Object.keys(workflows.properties["profile-kid-workflow"].properties.agents.properties),
    ).toEqual(["kid-agent"]);
    expect(schema.additionalProperties).toBe(false);
  });
});
