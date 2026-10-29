import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../src/cli/context.js";
import { regenerateFlowTypes, writeCheckedTypes } from "../../src/cli/flow-types.js";
import { fixture } from "./agboss.js";

/**
 * #468: reading the configured application tolerates only the CLI's own errors (a broken setting);
 * anything else — a bug, not the project's setting — is not swallowed into "the project's file".
 */
vi.mock("../../src/cli/application-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/cli/application-path.js")>()),
  configuredApplicationOf: () => {
    throw new TypeError("not a CLI error");
  },
}));

const projects: string[] = [];

afterEach(() => {
  for (const directory of projects.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const contextIn = (cwd: string, lines: string[] = []): CommandContext => ({
  command: "generate",
  values: {},
  positionals: [],
  json: false,
  io: {
    stdout: { write: () => true },
    stderr: { write: () => true },
    env: {},
    cwd,
    registerTypeScript: false,
  },
  say: (line) => lines.push(`say ${line}`),
  warn: (line) => lines.push(`warn ${line}`),
});

const STAR = fixture("test-workflow/test.workflow.ts");

const projectDirectory = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "agboss-types-unexpected-"));
  projects.push(cwd);
  return cwd;
};

describe("#468: an unexpected error reading the configured application", () => {
  it("agboss check: it is rethrown, never taken for a broken setting", async () => {
    const cwd = projectDirectory();

    const written = writeCheckedTypes(contextIn(cwd), { file: STAR, shown: STAR });

    await expect(written).rejects.toThrow(new TypeError("not a CLI error"));
    expect(existsSync(join(cwd, ".agboss"))).toBe(false);
  });

  it("agboss generate: it is the warning itself, and no types are written", async () => {
    const cwd = projectDirectory();
    const lines: string[] = [];

    await regenerateFlowTypes(contextIn(cwd, lines), [STAR]);

    expect(lines).toEqual(["warn types not regenerated: not a CLI error — run agboss check"]);
    expect(existsSync(join(cwd, ".agboss"))).toBe(false);
  });
});
