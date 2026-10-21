import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { usage } from "../../src/cli/usage.js";

interface PackageJson {
  readonly name: string;
  readonly bin: Readonly<Record<string, string>>;
  readonly dependencies: Readonly<Record<string, string>>;
}

const cli = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as PackageJson;
const framework = JSON.parse(
  readFileSync(new URL("../../../agboss/package.json", import.meta.url), "utf8"),
) as { readonly version: string };

describe("the command ships apart from the framework (#101, #205)", () => {
  it("AC1 (#101): the command is agboss, short agb — in agboss-cli", () => {
    expect(cli.name).toBe("agboss-cli");
    expect(cli.bin).toEqual({ agboss: "./bin/agboss.js", agb: "./bin/agboss.js" });
    expect(usage()).toContain("AGBoss");
  });

  it("is built on the exact framework version it ships with (it uses agboss/internal)", () => {
    expect(cli.dependencies.agboss).toBe(framework.version);
  });

  it("AC5 (#101): the command help says workflow, not bundle", () => {
    expect(usage()).not.toMatch(/bundle/i);
    expect(usage()).toContain("--start <full name>");
    expect(usage()).not.toContain("--workflow");
  });
});
