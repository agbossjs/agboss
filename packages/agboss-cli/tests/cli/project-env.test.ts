/** #1318d1: the project's `.env` is read from the folder of its package.json, never the working directory. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectEnv, packageDirOf } from "../../src/cli/project-env.js";

function project(): { readonly dir: string; readonly application: string } {
  const dir = mkdtempSync(join(tmpdir(), "project-env-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "package.json"), "{}");
  return { dir, application: join(dir, "src", "a.application.ts") };
}

describe("project .env", () => {
  it("is read from the package.json folder of the application, whatever the working directory", () => {
    const { dir, application } = project();
    writeFileSync(join(dir, ".env"), "SHOP_KEY=from-file\nSHOP_REGION=eu\n");
    const env: NodeJS.ProcessEnv = { SHOP_REGION: "us" };

    expect(loadProjectEnv(env, application)).toBe(join(dir, ".env"));
    // a variable the process already has wins
    expect(env).toEqual({ SHOP_KEY: "from-file", SHOP_REGION: "us" });
  });

  it("reads no .env.<name> file, and none in the working directory", () => {
    const { dir, application } = project();
    writeFileSync(join(dir, ".env.prod"), "SHOP_KEY=prod\n");
    const env: NodeJS.ProcessEnv = {};

    expect(loadProjectEnv(env, application)).toBeUndefined();
    expect(env).toEqual({});
  });

  it("finds the package folder upward from the application's folder", () => {
    const { dir } = project();
    mkdirSync(join(dir, "src", "deep"), { recursive: true });

    expect(packageDirOf(join(dir, "src", "deep"))).toBe(dir);
  });
});
