import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("empty directory: unpacked agboss-core-*.tgz bin delegates via AGBOSS_CLI_PACKAGE_SPEC to create a project", () => {
    const tmp = mkdtempSync(join(tmpdir(), "agboss-empty-dir-test-"));
    try {
      const packDir = join(tmp, "packed");
      const unpackDir = join(tmp, "unpacked");
      const emptyDir = join(tmp, "empty");
      const cacheDir = join(tmp, "npm-cache");
      for (const dir of [packDir, unpackDir, emptyDir, cacheDir]) {
        mkdirSync(dir, { recursive: true });
      }

      execFileSync("npm", ["pack", "--pack-destination", packDir], {
        cwd: frameworkDir,
        stdio: "pipe",
      });
      execFileSync("npm", ["pack", "--pack-destination", packDir], {
        cwd: cliDir,
        stdio: "pipe",
      });
      const agbossTarball = join(packDir, `agboss-core-${framework.version}.tgz`);
      const cliTarball = join(packDir, `agboss-cli-${cli.version}.tgz`);
      execFileSync("tar", ["-xzf", agbossTarball, "-C", unpackDir], { stdio: "pipe" });

      execFileSync(
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
          stdio: "pipe",
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
