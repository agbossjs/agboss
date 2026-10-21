import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { envelope, fixture, agboss, type AgbossCall } from "./agboss.js";

const WORKFLOW = fixture("test-workflow/test.workflow.ts");
const MISSING = fixture("cli/missing.application.ts");
const NOT_AN_APPLICATION = fixture("loader/none.workflow.ts");
const project = mkdtempSync(join(tmpdir(), "agboss-198-"));

afterAll(() => {
  rmSync(project, { recursive: true, force: true });
});

/** One line on stderr, no stack trace, nothing on stdout. */
function expectOneLine(call: AgbossCall, code: number, text: RegExp): void {
  expect(call.code).toBe(code);
  expect(call.stdout).toBe("");
  expect(call.stderr).toMatch(text);
  expect(call.stderr.trimEnd().split("\n")).toHaveLength(1);
  expect(call.stderr).not.toMatch(/\n\s+at /);
}

describe("#198 AC2: usage, project and conflict errors by exit code", () => {
  it("usage → 2: an unknown flag is named, with a pointer to the command's help", async () => {
    expectOneLine(
      await agboss(["run", "--application", WORKFLOW, "--bogus", "task"]),
      2,
      /unknown option --bogus — see agboss help run/,
    );
  });

  it("usage → 2: a missing required option and an unknown command", async () => {
    expectOneLine(
      await agboss(["replay", "--application", WORKFLOW]),
      2,
      /missing required option --version — see agboss help replay/,
    );
    expectOneLine(await agboss(["nope"]), 2, /unknown command "nope"/);
    expectOneLine(await agboss(["describe", "extra"]), 2, /unexpected argument "extra"/);
  });

  it('agboss run "task": a module without an @Application is a project error (3), a missing --application a usage one (2)', async () => {
    expectOneLine(
      await agboss(["run", "--application", NOT_AN_APPLICATION, "find jobs"]),
      3,
      /none\.workflow\.ts: expected exactly one exported @Application class, found 0/,
    );
    expectOneLine(
      await agboss(["run", "--application", MISSING, "find jobs"]),
      2,
      /Application file not found: .*missing\.application\.ts/,
    );
    expectOneLine(
      await agboss(["run", "--application", WORKFLOW]),
      2,
      /missing the input of chat-workflow-start: "<task>", --input <json> or --input-file <file>/,
    );
  });

  it("project → 3 without a stack; --json carries the error, --debug adds the stack", async () => {
    expectOneLine(
      await agboss(["describe", "--application", NOT_AN_APPLICATION]),
      3,
      /expected exactly one exported @Application/,
    );
    const json = await agboss(["describe", "--application", NOT_AN_APPLICATION, "--json"]);
    expect(json.code).toBe(3);
    expect(envelope(json)).toMatchObject({
      schema: 1,
      ok: false,
      command: "describe",
      warnings: [],
      error: {
        code: "application.load",
        message: expect.stringContaining("@Application") as string,
      },
    });
    const debug = await agboss(["describe", "--application", NOT_AN_APPLICATION, "--debug"]);
    expect(debug.code).toBe(3);
    expect(debug.stderr).toMatch(
      /ApplicationLoadError: \S+none\.workflow\.ts: expected[\s\S]*\n\s+at /,
    );
  });

  it("conflict → 4: agboss create over an existing project writes nothing", async () => {
    const first = await agboss(["create", "desk", "--yes", "--skip-install", "--json"], project);
    expect(first.code).toBe(0);
    const created = envelope(first);
    expect(created).toMatchObject({ schema: 1, ok: true, command: "create" });
    expect(created.created).toEqual(expect.arrayContaining(["package.json"]));

    const again = await agboss(["create", "desk", "--yes", "--skip-install", "--json"], project);

    expect(again.code).toBe(4);
    expect(envelope(again)).toMatchObject({
      ok: false,
      error: {
        code: "scaffold.conflict",
        message: expect.stringMatching(/^Already exists/) as string,
      },
    });
    expect(again.stderr.trimEnd().split("\n")).toHaveLength(1);
  });

  it("usage → 2 for generators too: an unknown kind", async () => {
    expectOneLine(await agboss(["g", "widget", "x"], project), 2, /Unknown kind "widget"/);
  });
});
