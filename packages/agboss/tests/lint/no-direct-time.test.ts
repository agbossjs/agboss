/**
 * #262 AC12: direct time in framework code fails the gate — `agboss/no-direct-time`, linted here
 * with the repo's own config, as `npm run lint` in `make check` does.
 */
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const RULE = "agboss/no-direct-time";
const FRAMEWORK_FILE = "packages/agboss/src/infrastructure/recovery.ts";

/** The rule's findings for `code` linted as the file at `path` (a framework source by default). */
async function findings(code: string, path: string = FRAMEWORK_FILE): Promise<string[]> {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintText(code, { filePath: `${root}${path}` });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === RULE)
    .map((message) => message.message);
}

const body = (lines: string): string => `export function planted(): unknown {\n${lines}\n}\n`;

describe("#262 AC12: no direct time in framework code (agboss/no-direct-time)", () => {
  it("flags a planted Date.now(), naming it and the Clock to use instead", async () => {
    const found = await findings(body("  return Date.now();"));

    expect(found).toHaveLength(1);
    expect(found[0]).toContain("`Date.now` in framework code");
    expect(found[0]).toContain("application's Clock");
  }, 60_000);

  it("flags every direct way to read the time or start a timer", async () => {
    const found = await findings(
      body(
        [
          "  const at = new Date();",
          "  const text = Date();",
          "  const tick = performance.now();",
          "  setTimeout(() => undefined, 10);",
          "  setInterval(() => undefined, 10);",
          "  globalThis.setTimeout(() => undefined, 10);",
          "  const signal = AbortSignal.timeout(10);",
          "  const later = [1].map(setTimeout);",
          "  return [at, text, tick, signal, later];",
        ].join("\n"),
      ),
    );

    expect(found.map((message) => message.split(" in framework code")[0])).toEqual([
      "`new Date()`",
      "`Date()`",
      "`performance.now`",
      "`setTimeout`",
      "`setInterval`",
      "`globalThis.setTimeout`",
      "`AbortSignal.timeout`",
      "`setTimeout`",
    ]);
  }, 60_000);

  it("flags the timer modules", async () => {
    const found = await findings(
      'import { setTimeout as wait } from "node:timers/promises";\nexport const pause = wait;\n',
    );

    expect(found).toEqual([expect.stringContaining('`import "node:timers/promises"`')]);
  }, 60_000);

  it("allows a given moment, parsing, a local of the same name, types and the Clock", async () => {
    const found = await findings(
      [
        'import type { Clock } from "./clock.js";',
        "type Timer = ReturnType<typeof setTimeout>;",
        "export function allowed(clock: Clock, setTimeout: (run: () => void) => void): Date[] {",
        "  setTimeout(() => undefined);",
        "  const timer: Timer | undefined = undefined;",
        '  const parsed = Date.parse("2026-01-01");',
        "  return [new Date(parsed), new Date(0), clock.now(), ...(timer === undefined ? [] : [])];",
        "}",
      ].join("\n"),
    );

    expect(found).toEqual([]);
  }, 60_000);

  it("does not apply to the real Clock implementation, nor outside the framework's sources", async () => {
    const planted = body("  return Date.now();");

    const inClock = await findings(planted, "packages/agboss/src/infrastructure/clock.ts");
    const inTests = await findings(planted, "packages/agboss/tests/lint/no-direct-time.test.ts");

    expect([inClock, inTests]).toEqual([[], []]);
  }, 60_000);
});
