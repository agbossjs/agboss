import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { usage } from "../../src/cli/usage.js";

interface PackageJson {
  readonly name: string;
  readonly version: string;
  readonly bin: Readonly<Record<string, string>>;
  readonly files: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
}

const cliDir = new URL("../..", import.meta.url).pathname;
const frameworkDir = new URL("../../../agboss", import.meta.url).pathname;
const cli = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")) as PackageJson;
// A child that runs for long is awaited, never run synchronously: execFileSync blocks the worker's
// event loop, and past vitest's 60 s RPC timeout the run fails with "Timeout calling onTaskUpdate"
// whatever the test asserts (#792).
const run = promisify(execFile);
const framework = JSON.parse(
  readFileSync(join(frameworkDir, "package.json"), "utf8"),
) as PackageJson;

describe("the command ships apart from the framework (#101, #205)", () => {
  it("AC1 (#101): the command is agboss and agboss-cli — in @agboss/cli", () => {
    expect(cli.name).toBe("@agboss/cli");
    expect(cli.bin).toEqual({ agboss: "bin/agboss.js", "agboss-cli": "bin/agboss.js" });
    expect(cli.files).toContain("NOTICE");
    expect(usage()).toContain("AGBoss");
  });

  it("is built on the exact framework version it ships with (it uses @agboss/core/internal)", () => {
    expect(cli.dependencies["@agboss/core"]).toBe(framework.version);
    expect(cli.dependencies.agboss).toBeUndefined();
  });

  it("AC5 (#101): the command help says workflow, not bundle", () => {
    expect(usage()).not.toMatch(/bundle/i);
    expect(usage()).toContain("--start <full name>");
    expect(usage()).not.toContain("--workflow");
  });

  it("local delegation: packages/agboss/bin/agboss.js finds the installed @agboss/cli", () => {
    const out = execFileSync(process.execPath, [join(frameworkDir, "bin/agboss.js"), "--help"], {
      cwd: cliDir,
      encoding: "utf8",
      env: { ...process.env, AGBOSS_NO_STAR: "1" },
    });

    expect(out).toContain("Usage: agboss <command>");
  });

  it("empty directory: unpacked agboss-core-*.tgz bin delegates via AGBOSS_CLI_PACKAGE_SPEC to create a project", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agboss-empty-dir-test-"));
    try {
      const packDir = join(tmp, "packed");
      const unpackDir = join(tmp, "unpacked");
      const emptyDir = join(tmp, "empty");
      const cacheDir = join(tmp, "npm-cache");
      for (const dir of [packDir, unpackDir, emptyDir, cacheDir]) {
        mkdirSync(dir, { recursive: true });
      }

      await run("npm", ["pack", "--pack-destination", packDir], { cwd: frameworkDir });
      await run("npm", ["pack", "--pack-destination", packDir], { cwd: cliDir });
      const agbossTarball = join(packDir, `agboss-core-${framework.version}.tgz`);
      const cliTarball = join(packDir, `agboss-cli-${cli.version}.tgz`);
      await run("tar", ["-xzf", agbossTarball, "-C", unpackDir]);

      await run(
        process.execPath,
        [join(unpackDir, "package/bin/agboss.js"), "create", "my-app", "--yes", "--skip-install"],
        {
          cwd: emptyDir,
          env: {
            ...process.env,
            AGBOSS_CLI_PACKAGE_SPEC: cliTarball,
            AGBOSS_NO_STAR: "1",
            npm_config_cache: cacheDir,
          },
        },
      );

      expect(existsSync(join(emptyDir, "my-app/package.json"))).toBe(true);
      expect(existsSync(join(emptyDir, "my-app/AGENTS.md"))).toBe(true);
      expect(existsSync(join(emptyDir, "my-app/src/my-app.application.ts"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});

interface Forbidden {
  readonly FORBIDDEN_PACKAGES: readonly string[];
  readonly lockfileForbiddenOf: (
    lock: unknown,
    workspace: string,
    names?: readonly string[],
  ) => readonly string[];
}
const repoDir = new URL("../../../../", import.meta.url).pathname;
const forbidden = (await import(join(repoDir, "scripts/packed/forbidden.mjs"))) as Forbidden;

describe("#791: the CLI installs no package with unfixed advisories", () => {
  it("extract-zip is forbidden (GHSA-jmr9-qjv8-65gv, GHSA-7pqw-9j4j-h8q3: no fixed release)", () => {
    expect(forbidden.FORBIDDEN_PACKAGES).toContain("extract-zip");
  });

  it("the lockfile's production tree of @agboss/cli has no forbidden package", () => {
    const lock: unknown = JSON.parse(readFileSync(join(repoDir, "package-lock.json"), "utf8"));

    expect(forbidden.lockfileForbiddenOf(lock, "packages/agboss-cli")).toEqual([]);
  });

  it("agboss studio runs on @langchain/langgraph-api, pinned; @langchain/langgraph-cli is gone", () => {
    expect(cli.dependencies["@langchain/langgraph-api"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(cli.dependencies["@langchain/langgraph-cli"]).toBeUndefined();
  });

  it("the check bites: langgraph-cli's extract-zip, its own and create-langgraph's, is found", () => {
    const lock = {
      packages: {
        "packages/agboss-cli": {
          name: "@agboss/cli",
          dependencies: { "@agboss/core": "0.1.1", lgc: "1" },
        },
        "node_modules/@agboss/core": { link: true, resolved: "packages/agboss" },
        "packages/agboss": { name: "@agboss/core", devDependencies: { "extract-zip": "2" } },
        "packages/agboss-cli/node_modules/lgc": {
          dependencies: { "create-langgraph": "1", "extract-zip": "2" },
          peerDependencies: { "optional-peer": "1" },
          peerDependenciesMeta: { "optional-peer": { optional: true } },
        },
        "node_modules/create-langgraph": { dependencies: { "extract-zip": "2" } },
        "node_modules/extract-zip": {},
        "node_modules/optional-peer": { dependencies: { "extract-zip": "2" } },
      },
    };

    // a dev dependency and an optional peer are never a user's install
    expect(forbidden.lockfileForbiddenOf(lock, "packages/agboss-cli")).toEqual([
      "@agboss/cli > lgc > extract-zip",
      "@agboss/cli > lgc > create-langgraph > extract-zip",
    ]);
  });
});
