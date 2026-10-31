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

  it("AC4: the framework ships no workflow — but the fault suite's fixture (#484), a test's own", () => {
    const decorated = (file: string): boolean => /^@Workflow\(/m.test(readFileSync(file, "utf8"));
    // the application every fault pod runs, published with `@agboss/core/testing/faults` only
    const fixture = join(framework, "testing", "faults", "fixture");

    expect(sources(framework).filter(decorated)).toEqual([join(fixture, "order.workflow.ts")]);
  });

  it("#489 AC2: the only in-repo example is flow-patterns (job-scout lives in agbossjs/agboss-examples)", () => {
    // the generator tests' temporary copies of flow-patterns (#197, git-ignored) are not examples
    const examples = readdirSync(join(root, "examples")).filter(
      (name) => !name.startsWith(".scaffold-tmp-"),
    );

    expect(examples).toEqual(["flow-patterns"]);
  });

  it("#489 AC2: no workspace, script or check names job-scout's package or folder", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      workspaces: readonly string[];
      scripts: Readonly<Record<string, string>>;
    };
    const lock = readFileSync(join(root, "package-lock.json"), "utf8");
    const configs = ["knip.jsonc", ".prettierignore", "scripts/check-suppressions.mjs"].map(
      (file) => readFileSync(join(root, file), "utf8"),
    );

    expect(pkg.workspaces).toEqual(["packages/*", "examples/*"]);
    expect(Object.values(pkg.scripts).filter((script) => script.includes("job-scout"))).toEqual([]);
    expect(lock).not.toContain("job-scout");
    expect(configs.filter((text) => text.includes("job-scout"))).toEqual([]);
  });

  it("#489 AC2: the root's studio and check:models run on flow-patterns", () => {
    const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Readonly<Record<string, string>>;
    };
    const flowPatterns = JSON.parse(
      readFileSync(join(root, "examples/flow-patterns/package.json"), "utf8"),
    ) as { scripts: Readonly<Record<string, string>> };

    expect(scripts.studio).toBe("npm run build && npm run studio -w flow-patterns-example");
    expect(scripts["check:models"]).toBe("npm run check:models -w flow-patterns-example");
    expect(flowPatterns.scripts["check:models"]).toBe("agboss check --models --env test");
    expect(scripts.check).toContain("npm run check -w flow-patterns-example");
    expect(scripts.check).toMatch(/&& npm run check:models$/);
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
