import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.js";

const root = new URL("../../..", import.meta.url).pathname;
const framework = new URL("../src", import.meta.url).pathname;
const sources = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(dir, file));

describe("framework and examples apart (#91)", () => {
  it("AC1: the framework never imports example code", () => {
    const offenders = sources(framework).filter((file) =>
      /from "[^"]*examples\//.test(readFileSync(file, "utf8")),
    );

    expect(offenders).toEqual([]);
  });

  it("AC4: the examples are job-scout and flow-patterns (#295); the framework ships no workflow", () => {
    const decorated = (file: string): boolean => /^@Workflow\(/m.test(readFileSync(file, "utf8"));

    // the generator tests' temporary copies of job-scout (#197, git-ignored) are not examples
    const examples = readdirSync(join(root, "examples")).filter(
      (name) => !name.startsWith(".scaffold-tmp-"),
    );

    expect([...examples].sort()).toEqual(["flow-patterns", "job-scout"]);
    expect(sources(framework).filter(decorated)).toEqual([]);
  });

  it("AC5: the public API says workflow, not bundle (the command help: agboss-cli)", () => {
    expect(Object.keys(publicApi).filter((name) => /bundle/i.test(name))).toEqual([]);
    expect(Object.keys(publicApi)).toEqual(
      expect.arrayContaining(["createAppDeps", "loadWorkflow"]),
    );
  });
  it("AC1 (#101, #205): the package is @agboss/core, with a proxy bin and no runtime dependency on @agboss/cli", () => {
    const pkg = JSON.parse(readFileSync(join(root, "packages/agboss/package.json"), "utf8")) as {
      name: string;
      bin?: unknown;
      files?: readonly string[];
      dependencies?: Readonly<Record<string, string>>;
    };

    expect(pkg.name).toBe("@agboss/core");
    expect(pkg.bin).toEqual({ agboss: "./bin/agboss.js" });
    expect(pkg.files).toEqual(expect.arrayContaining(["bin", "NOTICE"]));
    expect(pkg.dependencies?.["@agboss/cli"]).toBeUndefined();
    expect(pkg.dependencies?.["agboss-cli"]).toBeUndefined();
  });

  it("AC4 (#101): no graphInject / graphinject left in the repository's code, commands or docs", () => {
    const skip =
      /(^|\/)(node_modules|\.git|dist|coverage|\.langgraph_api|\.idea)(\/|$)|(^|\/)(\.env|package-lock\.json)$/;
    // the files git tracks: walking the tree races with tests that create and delete temp copies
    // (examples/.scaffold-tmp-*) and would also read untracked build output
    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n");
    const files = tracked.filter(
      (file) =>
        file !== "" &&
        !skip.test(file) &&
        /\.(ts|js|cjs|mjs|json|md|ya?ml|sh)$|Makefile$/.test(file),
    );
    const self = "packages/agboss/tests/boundary.test.ts";
    const selfJs = "packages/agboss/tests/boundary.test.js"; // names the old name on purpose
    const left = files.filter(
      (file) =>
        file !== self &&
        file !== selfJs &&
        /graphinject/i.test(readFileSync(join(root, file), "utf8")),
    );

    expect(left).toEqual([]);
  });
});
