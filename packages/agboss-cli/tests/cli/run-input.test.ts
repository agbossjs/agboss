import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startsOfApplication, type ApplicationStart } from "agboss/internal";
import { COMMANDS } from "../../src/cli/commands.js";
import type { CliIo, CommandContext } from "../../src/cli/context.js";
import { parseCommand } from "../../src/cli/parse.js";
import { runInputOf } from "../../src/cli/run-input.js";
import { DeskApplication } from "../fixtures/cli/desk/desk.workflow.js";
import { TestApplication } from "../../../agboss/tests/fixtures/test-workflow/test.workflow.js";
import { agboss, envelope, fixture } from "./agboss.js";

/** #268 AC3: `agboss run --input` / `--input-file` checked against the start's InputOf, by field. */

const APPLICATION = fixture("cli/desk/desk.workflow.ts");
const DTO = "screening-workflow-start";
const MAP = "criteria-screening-workflow-start";
const LIST = "batch-screening-workflow-start";
const folder = mkdtempSync(join(tmpdir(), "agboss-268-input-"));
const RUN = COMMANDS.run ?? { summary: "", usage: "", options: [] };
const io: CliIo = { stdout: process.stdout, stderr: process.stderr, env: {}, cwd: folder };

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

const startNamed = (name: string): ApplicationStart => {
  const found = [
    ...startsOfApplication(DeskApplication),
    ...startsOfApplication(TestApplication),
  ].find((start) => start.name === name);
  if (found === undefined) throw new Error(name);
  return found;
};

const contextOf = (argv: readonly string[]): CommandContext => ({
  command: "run",
  ...parseCommand("run", RUN, argv),
  json: false,
  io,
  say: () => undefined,
  warn: () => undefined,
});

const run = (...argv: string[]) => agboss(["run", "--application", APPLICATION, ...argv], folder);

describe("#268 AC3: the input of agboss run", () => {
  it("errors per field for DTO, listOf, map — every problem at once, exit 2, nothing starts", async () => {
    const dto = await run("--start", DTO, "--input", '{"name":7}');
    const map = await run("--start", MAP, "--input", '{"company":{},"request":{"criteria":3}}');
    const list = await run("--start", LIST, "--input", '[{"name":"Acme"},{}]', "--json");

    expect(dto.code).toBe(2);
    expect(dto.stderr).toMatch(
      /--input does not fit the input of screening-workflow-start: name: /,
    );
    expect(map.code).toBe(2);
    expect(map.stderr).toMatch(
      /--input does not fit the input of criteria-screening-workflow-start: company\.name: [^;]+; request\.criteria: /,
    );
    expect(list.code).toBe(2);
    expect(envelope(list)).toMatchObject({
      ok: false,
      error: {
        code: "input.invalid",
        message: expect.stringMatching(
          /^--input does not fit the input of batch-screening-workflow-start: \[1\]\.name: /,
        ) as string,
      },
    });
  });

  it("a start with a map input given by --input-file: checked the same way", async () => {
    writeFileSync(join(folder, "input.json"), JSON.stringify({ request: { criteria: "remote" } }));

    const call = await run("--start", MAP, "--input-file", "input.json");

    expect(call.code).toBe(2);
    expect(call.stderr).toMatch(
      /--input-file does not fit the input of criteria-screening-workflow-start: company: /,
    );
  });

  it("a value that fits is the start's input as given", () => {
    writeFileSync(join(folder, "batch.json"), '[{"name":"Acme"}]');

    expect(
      runInputOf(contextOf(["--input", '{"company":{"name":"Acme"}}']), startNamed(MAP)),
    ).toEqual({
      company: { name: "Acme" },
    });
    expect(runInputOf(contextOf(["--input-file", "batch.json"]), startNamed(LIST))).toEqual([
      { name: "Acme" },
    ]);
    expect(runInputOf(contextOf(["find", "jobs"]), startNamed("chat-workflow-start"))).toEqual({
      text: "find jobs",
    });
  });

  it("not JSON, a missing file, two inputs, none: usage errors (exit 2)", async () => {
    const notJson = await run("--start", MAP, "--input", "{company");
    const missing = await run("--start", MAP, "--input-file", "nope.json");
    const twice = await run("--start", MAP, "--input", "{}", "some", "words");
    const none = await run("--start", MAP);

    expect([notJson.code, missing.code, twice.code, none.code]).toEqual([2, 2, 2, 2]);
    expect(notJson.stderr).toMatch(/--input is not JSON: /);
    expect(missing.stderr).toMatch(/--input-file not found: \S+nope\.json/);
    expect(twice.stderr).toContain(
      'give the input once: "<task>", --input <json> or --input-file <file>',
    );
    expect(none.stderr).toContain("missing the input of criteria-screening-workflow-start");
  });

  it("a text goes only to a start taking WorkflowStartTextDto", async () => {
    const call = await run("--start", MAP, "find", "jobs");

    expect(call.code).toBe(2);
    expect(call.stderr).toContain(
      "criteria-screening-workflow-start does not take a text: give its input with --input <json> or --input-file <file>",
    );
  });
});
