/**
 * #895 D1: `testWith(App, { profile, profileRoot })` — a workflow under a profile in a test, as
 * `createApp(App, { profile, profileRoot })` runs it, with the test seams (scripted models, no keys).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type AgentsConfigOf } from "../../src/index.js";
import { ProfileError } from "../../src/config/profiles.js";
import { TestEnvironment } from "../../src/testing/environment.js";
import { testWith, type TestApp } from "../../src/testing/index.js";
import { ProfileApplication } from "./fixtures/profile.application.js";

const WORKFLOWS = ["profile-boss-workflow", "profile-kid-workflow"] as const;

/**
 * `profiles/<workflow>/<name>.yaml` under `root` for both workflows: the child's changes its
 * agent (`agents`), the parent has no agent — its profile only names a version.
 */
function profilesIn(root: string, profiles: Readonly<Record<string, string>>): string {
  for (const workflow of WORKFLOWS) {
    mkdirSync(join(root, "profiles", workflow), { recursive: true });
    for (const [name, agents] of Object.entries(profiles)) {
      const head = `profile: ${name}\nversion: 1.0.0-${name}\n`;
      const body =
        workflow === "profile-kid-workflow" ? `${head}agents:\n  kid-agent:\n${agents}` : head;
      writeFileSync(join(root, "profiles", workflow, `${name}.yaml`), body);
    }
  }
  return root;
}

const PROFILES = { "low-thinking": "    thinking: low\n", "to-cloud": "    model: cloud/x\n" };
const root = profilesIn(mkdtempSync(join(tmpdir(), "d1-")), PROFILES);

const settingsOf = (app: TestApp, workflow: string): AgentsConfigOf<string> => {
  const found = app.settings[workflow];
  if (found === undefined) throw new Error(`no settings of ${workflow}`);
  return found;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#895 D1: testWith applies a profile", () => {
  const withProfile = testWith(ProfileApplication, { profile: "low-thinking", profileRoot: root });

  withProfile(
    "#895 D1: the resolved settings show thinking low and the profile's version",
    ({ app }) => {
      const kidSettings = settingsOf(app, "profile-kid-workflow");

      expect(kidSettings.agents["kid-agent"]?.thinking).toBe("low");
      expect(kidSettings.version).toBe("1.0.0-low-thinking");
      expect(
        settingsOf(app, "profile-boss-workflow").agents["boss-agent"]?.thinking,
      ).toBeUndefined();
    },
  );

  withProfile("#895 D1: a child workflow the application does not list gets it too", ({ app }) => {
    expect(Object.keys(app.settings).sort()).toEqual([...WORKFLOWS]);
    expect(Object.values(app.settings).map((one) => one.version)).toEqual([
      "1.0.0-low-thinking",
      "1.0.0-low-thinking",
    ]);
  });

  testWith(ProfileApplication)("#895 D1: no profile — the base settings", ({ app }) => {
    expect(settingsOf(app, "profile-kid-workflow").agents["kid-agent"]?.thinking).toBeUndefined();
    expect(settingsOf(app, "profile-kid-workflow").version).toBe("1.0.0");
  });

  testWith(ProfileApplication, { profile: "base", profileRoot: "/nowhere" })(
    "#895 D1: the profile base is no profile (no file read)",
    ({ app }) => {
      expect(settingsOf(app, "profile-kid-workflow").version).toBe("1.0.0");
    },
  );

  it("#895 D1: settings is read-only", () => {
    const readOnly = (app: TestApp): void => {
      // @ts-expect-error -- a test reads what was applied; it does not set it
      app.settings = {};
    };
    expect(readOnly).toBeTypeOf("function");
  });
});

describe("#895 D1: an unknown profile", () => {
  const message = (name: string): RegExp =>
    new RegExp(`no profile "${name}"[^\\n]*available: base, low-thinking, to-cloud`);

  it("#895 D1: testWith — a ProfileError listing the available profiles, never ENOENT", async () => {
    const failure = TestEnvironment.of(ProfileApplication, { profile: "nope", profileRoot: root });

    await expect(failure).rejects.toBeInstanceOf(ProfileError);
    await expect(failure).rejects.toThrow(message("nope"));
  });

  it("#895 D1: createApp — the same error", async () => {
    const failure = createApp(ProfileApplication, { profile: "nope", profileRoot: root });

    await expect(failure).rejects.toBeInstanceOf(ProfileError);
    await expect(failure).rejects.toThrow(message("nope"));
  });

  it("#895 D1: no profiles directory at all — says so, still a ProfileError", async () => {
    const empty = mkdtempSync(join(tmpdir(), "d1-empty-"));

    await expect(
      TestEnvironment.of(ProfileApplication, { profile: "nope", profileRoot: empty }),
    ).rejects.toThrow(/no profile "nope"[^\n]*available: base$/m);
  });
});

describe("#895 D1: a profile that switches a model to an unserved one", () => {
  const unserved = /\[model\.unserved\] profile-kid-workflow agents\.kid-agent = cloud\/x/;

  it("#895 D1: testWith reports [model.unserved] at assembly, not at the first call", async () => {
    await expect(
      TestEnvironment.of(ProfileApplication, { profile: "to-cloud", profileRoot: root }),
    ).rejects.toThrow(unserved);
  });

  it("#895 D1: createApp reports it the same way", async () => {
    await expect(
      createApp(ProfileApplication, { profile: "to-cloud", profileRoot: root }),
    ).rejects.toThrow(unserved);
  });
});

describe("#895 D1: profileRoot", () => {
  const repo = mkdtempSync(join(tmpdir(), "d1-monorepo-"));
  const pkg = join(repo, "packages", "app");
  const here = pathToFileURL(join(pkg, "tests", "workflow.test.ts")).href;
  profilesIn(pkg, PROFILES);

  it("#895 D1: a monorepo package — fileURLToPath(new URL('..', import.meta.url)), cwd elsewhere", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(repo);
    const packageRoot = fileURLToPath(new URL("..", here));

    const environment = await TestEnvironment.of(ProfileApplication, {
      profile: "low-thinking",
      profileRoot: packageRoot,
    });

    expect(packageRoot.endsWith("app/") || packageRoot.endsWith("app\\")).toBe(true);
    expect(environment.assembled.workflows.map((one) => one.config.version)).toEqual([
      "1.0.0-low-thinking",
      "1.0.0-low-thinking",
    ]);
  });

  it("#895 D1: the default is process.cwd(), as in createApp", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(pkg);

    const environment = await TestEnvironment.of(ProfileApplication, { profile: "low-thinking" });

    expect(environment.assembled.workflows[0]?.config.version).toBe("1.0.0-low-thinking");
  });

  it("#895 D1: Windows path form — fileURLToPath gives C:\\…\\ (no leading slash), which joins", () => {
    const windows = fileURLToPath("file:///C:/repo/packages/app/tests/..", { windows: true });

    expect(windows).toBe("C:\\repo\\packages\\app\\");
    expect(win32.join(windows, "profiles", "w", "p.yaml")).toBe(
      "C:\\repo\\packages\\app\\profiles\\w\\p.yaml",
    );
    expect(new URL("file:///C:/repo/packages/app/").pathname).toBe("/C:/repo/packages/app/");
  });
});
