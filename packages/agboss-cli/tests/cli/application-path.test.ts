import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applicationPathOf } from "../../src/cli/application-path.js";
import type { CommandContext } from "../../src/cli/context.js";
import { CliError } from "../../src/cli/errors.js";
import { agboss, envelope, fixture } from "./agboss.js";

/** #268 AC1: the application's path is set once in package.json, or given with --application. */

const APPLICATION = fixture("test-workflow/test.workflow.ts");
const folders: string[] = [];

afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

/** A project folder whose package.json has the given `agboss` field (none: no field). */
function projectWith(agboss?: unknown): string {
  const folder = mkdtempSync(join(tmpdir(), "agboss-268-path-"));
  folders.push(folder);
  const field = agboss === undefined ? {} : { agboss };
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "p", ...field }));
  return folder;
}

const contextIn = (cwd: string, values: CommandContext["values"] = {}): CommandContext => ({
  command: "describe",
  values,
  positionals: [],
  json: false,
  io: { stdout: process.stdout, stderr: process.stderr, env: {}, cwd },
  say: () => undefined,
  warn: () => undefined,
});

describe("#268 AC1: where the application is", () => {
  it('"agboss": { "application" } in package.json, relative to its folder — also from a subfolder', () => {
    const project = projectWith();
    const shown = relative(project, APPLICATION);
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ agboss: { application: shown } }),
    );
    mkdirSync(join(project, "src"));

    expect(applicationPathOf(contextIn(project))).toEqual({ file: APPLICATION, shown });
    expect(applicationPathOf(contextIn(join(project, "src")))).toEqual({
      file: APPLICATION,
      shown,
    });
  });

  it("agboss describe runs the application of package.json", async () => {
    const project = projectWith({ application: APPLICATION });

    const call = await agboss(["describe", "--json"], project);

    expect(call.code).toBe(0);
    expect(envelope(call).result).toMatchObject({ application: { name: "test-application" } });
  });

  it("--application wins over package.json", async () => {
    const project = projectWith({ application: "src/missing.application.ts" });

    const call = await agboss(["describe", "--application", APPLICATION, "--json"], project);

    expect(call.code).toBe(0);
    expect(applicationPathOf(contextIn(project, { application: APPLICATION }))).toEqual({
      file: APPLICATION,
      shown: APPLICATION,
    });
  });

  it("neither set: exit 3, the error says where to set it", async () => {
    const call = await agboss(["describe", "--json"], projectWith());

    expect(call.code).toBe(3);
    expect(envelope(call)).toMatchObject({
      ok: false,
      error: {
        code: "application.path-not-set",
        message:
          'No application: set "agboss": { "application": "src/<name>.application.ts" } in package.json, or pass --application <path>',
      },
    });
  });

  it("a path in package.json that is missing or not a path: exit 3 naming the package.json", async () => {
    const missing = await agboss(["check"], projectWith({ application: "src/x.application.ts" }));
    const invalid = await agboss(["check"], projectWith({ application: 42 }));

    expect(missing.code).toBe(3);
    expect(missing.stderr).toMatch(
      /Application file not found: \S+x\.application\.ts \(set in \S+package\.json as "agboss": \{ "application": "src\/x\.application\.ts" \}\)/,
    );
    expect(invalid.code).toBe(3);
    expect(invalid.stderr).toMatch(/package\.json: "agboss": \{ "application" \} must be the path/);
  });

  it("a package.json that is not JSON is the project's to fix (exit 3)", () => {
    const project = projectWith();
    writeFileSync(join(project, "package.json"), "{ not json");

    expect(() => applicationPathOf(contextIn(project))).toThrow(CliError);
  });

  it("an --application that does not exist is a usage error (exit 2)", async () => {
    const call = await agboss(["describe", "--application", "nope.application.ts"], projectWith());

    expect(call.code).toBe(2);
    expect(call.stderr).toMatch(
      /Application file not found: \S+nope\.application\.ts \(--application nope\.application\.ts\)/,
    );
  });

  it("a module without exactly one @Application: exit 3 (application.load)", async () => {
    const none = await agboss(
      ["describe", "--application", fixture("loader/none.workflow.ts"), "--json"],
      projectWith(),
    );

    expect(none.code).toBe(3);
    expect(envelope(none)).toMatchObject({ error: { code: "application.load" } });
  });

  it("--workflow <path> is gone (AC1): an unknown option, exit 2", async () => {
    const call = await agboss(["describe", "--workflow", APPLICATION]);

    expect(call.code).toBe(2);
    expect(call.stderr).toMatch(/unknown option --workflow/);
  });
});
