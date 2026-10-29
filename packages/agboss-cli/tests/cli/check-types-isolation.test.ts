import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../../src/cli/context.js";
import { regenerateFlowTypes } from "../../src/cli/flow-types.js";
import { agboss, envelope, fixture } from "./agboss.js";

/** #468: checking another application never rewrites the project's own `.agboss/types.d.ts`. */

const PARTS = fixture("cli/parts.workflow.ts");
const STAR = fixture("test-workflow/test.workflow.ts");

const projects: string[] = [];
const projectOf = (application: string | undefined): string => {
  const directory = mkdtempSync(join(tmpdir(), "agboss-types-isolation-"));
  projects.push(directory);
  const agbossField = application === undefined ? {} : { agboss: { application } };
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "p", ...agbossField }));
  return directory;
};
const typesOf = (directory: string): string => join(directory, ".agboss/types.d.ts");
const scopedTypesOf = (directory: string): string[] =>
  readdirSync(join(directory, ".agboss")).filter((name) => name !== "types.d.ts");

afterEach(() => {
  for (const directory of projects.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("#468: --application isolates the generated types", () => {
  it("another application is typed in a file of its own, the project's file is untouched", async () => {
    const cwd = projectOf(PARTS);
    await agboss(["check"], cwd);
    const before = readFileSync(typesOf(cwd), "utf8");

    const call = await agboss(["check", "--application", STAR, "--json"], cwd);

    expect(call.code).toBe(0);
    expect(readFileSync(typesOf(cwd), "utf8")).toBe(before);
    const [scoped, ...others] = scopedTypesOf(cwd);
    expect(others).toEqual([]);
    expect(scoped).toMatch(/^types\..+\.d\.ts$/);
    expect(readFileSync(join(cwd, ".agboss", scoped ?? ""), "utf8")).toContain("test-workflow");
  });

  it("the project's own application still writes .agboss/types.d.ts", async () => {
    const cwd = projectOf(PARTS);

    const call = await agboss(["check", "--application", PARTS], cwd);

    expect(call.code).toBe(0);
    expect(existsSync(typesOf(cwd))).toBe(true);
    expect(scopedTypesOf(cwd)).toEqual([]);
  });

  it("no application set in package.json: the one given writes .agboss/types.d.ts", async () => {
    const cwd = projectOf(undefined);

    const call = await agboss(["check", "--application", STAR], cwd);

    expect(call.code).toBe(0);
    expect(existsSync(typesOf(cwd))).toBe(true);
    expect(scopedTypesOf(cwd)).toEqual([]);
  });
});

const HIDDEN = fixture("cli/hidden.workflow.ts");
const THROWS = fixture("cli/throws.workflow.ts");
const REPORT = fixture("cli/report.workflow.ts");

/** A project whose `src/` and `cases/` modules re-export the fixtures' applications. */
const projectWith = (modules: Readonly<Record<string, string>>, application: string): string => {
  const directory = projectOf(application);
  for (const [path, target] of Object.entries(modules)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), `export * from ${JSON.stringify(target)};\n`);
  }
  return directory;
};

describe("#468: what is and is not isolated", () => {
  it("AC2: a fixture whose generation fails writes nothing — neither file is touched", async () => {
    const cwd = projectOf(PARTS);
    await agboss(["check"], cwd);
    const before = readFileSync(typesOf(cwd), "utf8");

    const call = await agboss(["check", "--application", HIDDEN], cwd);

    expect(call.code).toBe(3);
    expect(call.stdout).toContain("types.unexported-class");
    expect(readFileSync(typesOf(cwd), "utf8")).toBe(before);
    expect(scopedTypesOf(cwd)).toEqual([]);
  });

  it("a fixture that does not load is a failure of its own, the project's file untouched", async () => {
    const cwd = projectOf(PARTS);
    await agboss(["check"], cwd);
    const before = readFileSync(typesOf(cwd), "utf8");

    const call = await agboss(["check", "--application", THROWS], cwd);

    expect(call.code).not.toBe(0);
    expect(readFileSync(typesOf(cwd), "utf8")).toBe(before);
  });

  it("checking the same fixture again rewrites its file, not the project's", async () => {
    const cwd = projectOf(PARTS);
    await agboss(["check"], cwd);
    const before = readFileSync(typesOf(cwd), "utf8");

    await agboss(["check", "--application", STAR], cwd);
    const [first] = scopedTypesOf(cwd);
    await agboss(["check", "--application", STAR], cwd);

    expect(scopedTypesOf(cwd)).toEqual([first]);
    expect(readFileSync(typesOf(cwd), "utf8")).toBe(before);
  });

  it("two fixtures get two files, and the project's file is the same after both", async () => {
    const cwd = projectOf(PARTS);
    await agboss(["check"], cwd);
    const before = readFileSync(typesOf(cwd), "utf8");

    const first = await agboss(["check", "--application", STAR], cwd);
    const second = await agboss(["check", "--application", REPORT], cwd);

    expect([first.code, second.code]).toEqual([0, 0]);
    const scoped = scopedTypesOf(cwd);
    expect(scoped).toHaveLength(2);
    expect(new Set(scoped).size).toBe(2);
    expect(readFileSync(typesOf(cwd), "utf8")).toBe(before);
  });

  it("--json names the scoped file as the written types", async () => {
    const cwd = projectOf(PARTS);
    await agboss(["check"], cwd);

    const call = await agboss(["check", "--application", STAR, "--json"], cwd);

    const [scoped] = scopedTypesOf(cwd);
    expect(envelope(call)).toMatchObject({
      ok: true,
      result: { types: `.agboss/${scoped ?? ""}` },
    });
  });

  it("the plain output says which file the types went to", async () => {
    const cwd = projectOf(PARTS);

    const call = await agboss(["check", "--application", STAR], cwd);

    const [scoped] = scopedTypesOf(cwd);
    expect(call.stdout).toContain(`types: .agboss/${scoped ?? ""}\n`);
    expect(call.stdout).not.toContain("types: .agboss/types.d.ts");
  });

  it("the name is made of the module's path inside the project, without its extension", async () => {
    const cwd = projectWith({ "cases/one/agboss-fixed/application.ts": STAR }, PARTS);

    await agboss(["check", "--application", "cases/one/agboss-fixed/application.ts"], cwd);

    expect(scopedTypesOf(cwd)).toEqual(["types.cases-one-agboss-fixed-application.d.ts"]);
  });

  it("a module outside the project folder is named without the leading ..", async () => {
    const cwd = projectOf(PARTS);

    await agboss(["check", "--application", STAR], cwd);

    const [scoped] = scopedTypesOf(cwd);
    expect(scoped).not.toContain("..");
    expect(scoped).toMatch(/^types\.[^/]+-test-workflow-test\.workflow\.d\.ts$/);
  });

  it("another module of the application's own src/ is the project's types, not a scoped file", async () => {
    const cwd = projectWith(
      { "src/main.application.ts": PARTS, "src/second.application.ts": PARTS },
      "src/main.application.ts",
    );

    const call = await agboss(["check", "--application", "src/second.application.ts"], cwd);

    expect(call.stderr).not.toContain("agboss check:");
    expect(existsSync(typesOf(cwd))).toBe(true);
    expect(scopedTypesOf(cwd)).toEqual([]);
  });

  it("the configured application given explicitly is still the project's types", async () => {
    const cwd = projectWith({ "src/main.application.ts": PARTS }, "src/main.application.ts");

    await agboss(["check", "--application", "src/main.application.ts"], cwd);

    expect(existsSync(typesOf(cwd))).toBe(true);
    expect(scopedTypesOf(cwd)).toEqual([]);
  });

  it("a fixture next to an application in src/ does not narrow the project's types", async () => {
    const cwd = projectWith(
      { "src/main.application.ts": PARTS, "cases/one/application.ts": STAR },
      "src/main.application.ts",
    );
    await agboss(["check"], cwd);
    const before = readFileSync(typesOf(cwd), "utf8");

    await agboss(["check", "--application", "cases/one/application.ts"], cwd);

    expect(before).toContain('"six-parts-agent"');
    expect(readFileSync(typesOf(cwd), "utf8")).toBe(before);
  });
});

describe("#468: agboss generate", () => {
  const contextIn = (cwd: string, lines: string[]): CommandContext => ({
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

  it("a workflow of the project's own application regenerates the project's file", async () => {
    const cwd = projectOf(PARTS);
    const lines: string[] = [];

    await regenerateFlowTypes(contextIn(cwd, lines), [PARTS]);

    expect(lines).toEqual(["say   types: .agboss/types.d.ts"]);
    expect(existsSync(typesOf(cwd))).toBe(true);
  });

  it("a workflow of another application is typed in a file of its own", async () => {
    const cwd = projectOf(PARTS);
    await agboss(["check"], cwd);
    const before = readFileSync(typesOf(cwd), "utf8");
    const lines: string[] = [];

    await regenerateFlowTypes(contextIn(cwd, lines), [STAR]);

    const [scoped] = scopedTypesOf(cwd);
    expect(lines).toEqual([`say   types: .agboss/${scoped ?? ""}`]);
    expect(readFileSync(typesOf(cwd), "utf8")).toBe(before);
  });
});
