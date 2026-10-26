import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { globToRegExp, placeTests, testPatterns } from "../../src/scaffold/test-location.js";

const projectWith = (config: string | undefined): string => {
  const root = mkdtempSync(join(tmpdir(), "agboss-tests-"));
  if (config !== undefined) writeFileSync(join(root, "vitest.config.ts"), config);
  return root;
};

const toolTest = {
  path: "src/tools/refund.tool.test.ts",
  content:
    'import { x } from "@agboss/core/testing";\nimport { RefundTool } from "./refund.tool.js";\nimport { Api } from "../services/api.service.js";\n',
};

describe("#197: generated tests go where the project's vitest config looks", () => {
  it("globs: ** spans folders, * stays in one, braces are alternatives", () => {
    expect(globToRegExp("tests/**/*.test.ts").test("tests/refund.tool.test.ts")).toBe(true);
    expect(globToRegExp("tests/**/*.test.ts").test("tests/a/b.test.ts")).toBe(true);
    expect(globToRegExp("src/*.test.ts").test("src/tools/a.test.ts")).toBe(false);
    expect(globToRegExp("src/**/*.{test,spec}.ts").test("src/a.spec.ts")).toBe(true);
  });

  it("reads test.include and the projects' includes, never coverage.include", () => {
    const root = projectWith(
      'export default { test: { include: ["tests/**/*.test.ts"], coverage: { include: ["src/**/*.ts"] } } };',
    );

    expect(testPatterns(root)).toEqual({ include: ["tests/**/*.test.ts"], exclude: [] });
  });

  it("a test the config would not run moves under its test folder, imports rewritten", () => {
    const root = projectWith('export default { test: { include: ["tests/**/*.test.ts"] } };');

    const [moved] = placeTests(root, [toolTest]);

    expect(moved?.path).toBe("tests/tools/refund.tool.test.ts");
    expect(moved?.content).toBe(
      'import { x } from "@agboss/core/testing";\nimport { RefundTool } from "../../src/tools/refund.tool.js";\nimport { Api } from "../../src/services/api.service.js";\n',
    );
  });

  it("a test the config finds, or a project without a config, keeps its place", () => {
    const colocated = projectWith(
      'export default { test: { projects: [{ test: { include: ["src/**/*.test.ts"], exclude: ["src/**/*.suite.test.ts"] } }] } };',
    );

    expect(placeTests(colocated, [toolTest])).toEqual([toolTest]);
    expect(placeTests(projectWith(undefined), [toolTest])).toEqual([toolTest]);
  });
});
