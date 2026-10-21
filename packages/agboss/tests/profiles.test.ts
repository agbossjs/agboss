import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TestWorkflow } from "./fixtures/test-workflow/test.workflow.js";
import { workflowOf } from "../src/testing/index.js";
import {
  deepMerge,
  loadProfile,
  ProfileError,
  profileJsonSchema,
  type Profile,
} from "../src/config/profiles.js";
import { applyProfile, withProfile } from "../src/profile-workflow.js";

const base = await workflowOf(TestWorkflow);
/** Raw (possibly invalid) profile content, as a YAML file would give it. */
const profile = (overrides: Record<string, unknown> = {}): Profile =>
  ({ profile: "variant", version: "1.0.0-variant", ...overrides }) as Profile;

async function profileFile(
  content: string,
  name = "variant",
): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "profiles-"));
  const file = join(root, "profiles", base.config.name, `${name}.yaml`);
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(join(root, "profiles", base.config.name), { recursive: true }),
  );
  await writeFile(file, content);
  return { root, file };
}

describe("profiles — merge rules", () => {
  it("AC1: objects merge key by key, arrays and scalars replace", () => {
    expect(
      deepMerge({ a: { x: 1, y: 2 }, list: [1, 2], s: "a" }, { a: { y: 3 }, list: [9], s: "b" }),
    ).toEqual({
      a: { x: 1, y: 3 },
      list: [9],
      s: "b",
    });
  });

  it("AC1: a profile overrides only what it lists; prompts replaced per agent", async () => {
    const applied = applyProfile(
      base,
      profile({
        agents: { "coder-agent": { thinking: "high" } },
        defaults: { uncompactedTurns: 2 },
      }),
      { "coder-agent": "You are a terse coder." },
      "p.yaml",
    );

    expect(applied.config.version).toBe("1.0.0-variant");
    expect(applied.config.agents["coder-agent"]?.thinking).toBe("high");
    expect(applied.config.agents["coder-agent"]?.model).toBe(
      base.config.agents["coder-agent"]?.model,
    );
    expect(applied.config.defaults.uncompactedTurns).toBe(2);
    expect(applied.prompts["coder-agent"]).toBe("You are a terse coder.");
    expect(applied.prompts["researcher-agent"]).toBe(base.prompts["researcher-agent"]);
  });

  it("AC1: loads a YAML profile with a prompt file relative to it; base means no profile", async () => {
    const { root, file } = await profileFile(
      "profile: variant\nversion: 1.0.0-variant\nprompts:\n  coder-agent: { file: coder.md }\n",
    );
    await writeFile(join(root, "profiles", base.config.name, "coder.md"), "From a file.");

    const applied = await withProfile(base, "variant", root);

    expect(applied.prompts["coder-agent"]).toBe("From a file.");
    expect(await withProfile(base, "base", root)).toBe(base);
    expect(await loadProfile(file)).toMatchObject({ profile: "variant" });
  });
});

describe("profiles — validation", () => {
  it("AC1: a typo in a key is rejected with the file and the path", async () => {
    const { file } = await profileFile(
      "profile: variant\nversion: 2.0.0\nagents:\n  coder:\n    thinkin: low\n",
    );

    await expect(loadProfile(file)).rejects.toThrow(`${file}: agents.coder`);
  });

  it("AC1: unknown agents, the base version and invalid values are rejected", () => {
    expect(() =>
      applyProfile(base, profile({ agents: { ghost: { thinking: "low" } } }), {}, "p.yaml"),
    ).toThrow(/unknown in workflow "test-workflow": agents\.ghost/);
    expect(() =>
      applyProfile(base, profile({ version: base.config.version }), {}, "p.yaml"),
    ).toThrow(ProfileError);
    expect(() =>
      applyProfile(base, profile({ defaults: { uncompactedTurns: -1 } }), {}, "p.yaml"),
    ).toThrow(/p\.yaml: defaults\.uncompactedTurns/);
    expect(() =>
      applyProfile(
        base,
        profile({ compactions: { "ghost-compaction": { turnsBetweenCompactions: 2 } } }),
        {},
        "p.yaml",
      ),
    ).toThrow(/compactions\.ghost-compaction/);
  });

  it("#116: routers and budget are no longer profile keys (the flow and settings() own them)", async () => {
    const { file } = await profileFile(
      "profile: variant\nversion: 2.0.0\nrouters:\n  main:\n    maxHops: 5\n",
    );
    const budget = await profileFile("profile: v2\nversion: 2.0.0\nbudget:\n  runBudgetCap: 1\n");

    await expect(loadProfile(file)).rejects.toThrow(ProfileError);
    await expect(loadProfile(budget.file)).rejects.toThrow(ProfileError);
  });

  it("AC1: schema/profile.schema.json is up to date (run `npm run schema`)", async () => {
    const committed: unknown = JSON.parse(await readFile("schema/profile.schema.json", "utf8"));

    expect(committed).toEqual(profileJsonSchema());
  });
});
