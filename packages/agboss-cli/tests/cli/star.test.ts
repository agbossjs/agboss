import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runWithStar, shouldShowStar, STAR_LINE, type StarContext } from "../../src/cli/star.js";
import { usage } from "../../src/cli/usage.js";

const interactive: StarContext = { isTTY: true, env: {}, argv: ["help"] };

const recorder = (): { readonly lines: string[]; readonly write: (text: string) => boolean } => {
  const lines: string[] = [];
  return {
    lines,
    write: (text: string) => {
      lines.push(text);
      return true;
    },
  };
};

const main = new URL("../../src/cli/main.ts", import.meta.url).pathname;
const workflow = new URL(
  "../../../agboss/tests/fixtures/test-workflow/test.workflow.ts",
  import.meta.url,
).pathname;
/** The CLI package: tsx applies its tsconfig `paths`, so `agboss` is the framework source too. */
const cliRoot = new URL("../..", import.meta.url).pathname;

/** `agboss` from source in a child process (one copy of the framework): stderr is a pipe, not a terminal. */
const agboss = (
  args: readonly string[],
): { status: number | null; stdout: string; stderr: string } => {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete env.CI;
  delete env.AGBOSS_NO_STAR;
  const result = spawnSync(process.execPath, ["--import", "tsx", main, ...args], {
    cwd: cliRoot,
    encoding: "utf8",
    env,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

describe("the star line (#129)", () => {
  it("AC1: shown on a terminal without flags or env", () => {
    expect(shouldShowStar(interactive)).toBe(true);
  });

  it.each<[string, StarContext]>([
    ["stderr is not a terminal", { ...interactive, isTTY: false }],
    ["CI is set", { ...interactive, env: { CI: "1" } }],
    ["--json is passed", { ...interactive, argv: ["describe", "--json"] }],
    ["--quiet is passed", { ...interactive, argv: ["run", "--quiet", "task"] }],
    ["AGBOSS_NO_STAR=1", { ...interactive, env: { AGBOSS_NO_STAR: "1" } }],
  ])("AC1: hidden when %s", (_, context) => {
    expect(shouldShowStar(context)).toBe(false);
  });

  it("AC1: AGBOSS_NO_STAR=0 does not hide it", () => {
    expect(shouldShowStar({ ...interactive, env: { AGBOSS_NO_STAR: "0" } })).toBe(true);
  });

  it("AC1: on a terminal the line is written once, last, after the command's output", async () => {
    const stderr = recorder();

    const end = await runWithStar(
      () => Promise.resolve(void stderr.write("command output\n")),
      interactive,
      stderr,
    );

    expect(end).toBe("completed");
    expect(stderr.lines).toEqual(["command output\n", `${STAR_LINE}\n`]);
    expect(STAR_LINE).toBe("⭐ Like AGBoss? Star us on GitHub: https://github.com/agbossjs/agboss");
  });

  it("AC1: nothing is written when the star is off", async () => {
    const stderr = recorder();

    await runWithStar(() => Promise.resolve(), { ...interactive, isTTY: false }, stderr);

    expect(stderr.lines).toEqual([]);
  });

  it("AC2: agboss help (not a terminal) — no star line on stdout or stderr", () => {
    const result = agboss(["help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: agboss <command>");
    expect(`${result.stdout}${result.stderr}`).not.toContain(STAR_LINE);
  });

  it("AC2: agboss describe (not a terminal) — no star line on stdout or stderr", () => {
    const result = agboss(["describe", "--application", workflow]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("researcher");
    expect(`${result.stdout}${result.stderr}`).not.toContain(STAR_LINE);
  });

  it("AC3: a command that throws fails, its error is written, then the star line", async () => {
    const stderr = recorder();

    const end = await runWithStar(() => Promise.reject(new Error("boom")), interactive, stderr);

    expect(end).toBe("threw");
    expect(stderr.lines[0]).toContain("Error: boom");
    expect(stderr.lines.at(-1)).toBe(`${STAR_LINE}\n`);
  });

  it("AC3: a command's own exit code is kept (unknown command → 1, star after the error)", async () => {
    const stderr = recorder();
    const before = process.exitCode;

    const end = await runWithStar(
      () => {
        stderr.write('Unknown command "nope".\n');
        process.exitCode = 1;
        return Promise.resolve();
      },
      interactive,
      stderr,
    );
    const code = process.exitCode;
    process.exitCode = before;

    expect(end).toBe("completed");
    expect(code).toBe(1);
    expect(stderr.lines).toEqual(['Unknown command "nope".\n', `${STAR_LINE}\n`]);
  });

  it("AC3: agboss with an unknown command exits with the usage code 2 (#198)", () => {
    const result = agboss(["nope"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('agboss nope: unknown command "nope" — see agboss help');
  });

  it("spec: agboss help documents AGBOSS_NO_STAR and when the line is hidden", () => {
    const text = usage();

    expect(text).toContain("AGBOSS_NO_STAR=1");
    expect(text).toMatch(/not a terminal.*CI.*--json.*--quiet/s);
  });
});
