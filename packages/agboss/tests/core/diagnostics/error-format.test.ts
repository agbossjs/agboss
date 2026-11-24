import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../src/index.js";
import { AGBossError, BacktraceMode } from "../../../src/errors.js";
import { backtraceModeOf } from "../../../src/core/diagnostics/backtrace.js";
import { inTestFrame } from "../../helpers/frame.js";

/** #1325c: `error.format()` — the color-eyre report: chain, Location, Span trace, Stack backtrace. */

const CWD = process.cwd();
const THIS_FILE = "tests/core/diagnostics/error-format.test.ts";

class SampleError extends AGBossError {
  static override readonly code = "sample";
}

const thrownByUser = (cause?: unknown): SampleError =>
  new SampleError("the charge failed", { cause });

describe("error.format()", () => {
  it("numbers the chain of framework causes, outermost first", () => {
    const inner = new SampleError("the key was settled");
    const outer = new SampleError("step failed", { cause: inner });

    const text = outer.format({ backtrace: BacktraceMode.Off, cwd: CWD });

    expect(text.split("\n").slice(0, 3)).toEqual([
      "Error:",
      "   0: step failed",
      "   1: the key was settled",
    ]);
    expect(outer.chain()).toEqual([outer, inner]);
  });

  it("names where the user's code threw it", () => {
    const error = thrownByUser();

    const text = error.format({ backtrace: BacktraceMode.Off, cwd: CWD });

    expect(text).toMatch(new RegExp(`\\nLocation:\\n   ${THIS_FILE}:\\d+:\\d+\\n`, "u"));
    expect(error.location).toMatchObject({ line: expect.any(Number) as number });
    expect(error.location?.file).toBe(`${CWD}/${THIS_FILE}`);
  });

  it("prints the user's frames as two lines each, the rest counted, in Short mode", () => {
    const text = thrownByUser().format({ backtrace: BacktraceMode.Short, cwd: CWD });

    expect(text).toMatch(
      /\nStack backtrace:\n {3}0: thrownByUser\n {13}at \.\/tests\/core\/diagnostics\/error-format\.test\.ts:\d+:\d+\n/u,
    );
    expect(text).toMatch(/\[\.\.\. \d+ internal frames omitted \.\.\.\]/u);
    expect(
      text.endsWith(
        "note: Run with `AGBOSS_BACKTRACE=full` environment variable to display a full backtrace.",
      ),
    ).toBe(true);
  });

  it("prints every frame in Full mode and no note", () => {
    const text = thrownByUser().format({ backtrace: BacktraceMode.Full, cwd: CWD });

    expect(text).toContain("node_modules/");
    expect(text).not.toContain("internal frames omitted");
    expect(text).not.toContain("AGBOSS_BACKTRACE");
  });

  it("prints no stack in Off mode, and says how to see one", () => {
    const text = thrownByUser().format({ backtrace: BacktraceMode.Off, cwd: CWD });

    expect(text).not.toContain("Stack backtrace");
    expect(text).toContain("`AGBOSS_BACKTRACE=1`");
  });

  it("prints a stack that holds none of the message", () => {
    const error = new SampleError("line one\nline two");

    const text = error.format({ backtrace: BacktraceMode.Short, cwd: CWD });

    expect(text).toContain("   0: line one\n       line two");
  });

  it("prints the suggestion, the patch and the notes the thrower gave", () => {
    const error = new SampleError("settled", {
      help: "pass the same fingerprint on a retry",
      suggestionPatch: "12 |   run(key)\n13 +   run(key, fingerprint)",
      notes: ["the key stays reserved for 30 days"],
      location: { file: `${CWD}/src/a.ts`, line: 3, column: 5 },
    });

    const text = error.format({ backtrace: BacktraceMode.Full, cwd: CWD });

    expect(text.startsWith("Error:\n   0: settled\n\nLocation:\n   src/a.ts:3:5\n")).toBe(true);
    const tail = text.split("\n\n").at(-1);
    expect(tail).toBe(
      [
        "Suggestion: pass the same fingerprint on a retry",
        "12 |   run(key)",
        "13 +   run(key, fingerprint)",
        "note: the key stays reserved for 30 days",
      ].join("\n"),
    );
  });

  it("ends a chain that points back at itself", () => {
    const first = new SampleError("first");
    const second = new SampleError("second", { cause: first });
    Object.defineProperty(first, "cause", { value: second });

    expect(first.chain()).toEqual([first, second]);
    expect(first.format({ backtrace: BacktraceMode.Off, cwd: CWD })).toContain("   1: second");
  });

  it("is what util.inspect and console.log print", () => {
    const error = thrownByUser();

    expect(inspect(error)).toBe(error.format());
  });

  it("keeps the error's own properties and its JSON free of report fields", () => {
    const error = new SampleError("settled", { help: "h", notes: ["n"], details: { key: 1 } });

    expect(Object.keys(error).sort()).toEqual(["code", "details", "name"].sort());
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: "sample",
      details: { key: 1 },
      name: "SampleError",
    });
  });

  it("takes the report's facts through a family variant's constructor", () => {
    const error = new ValidationError.TenantRequired({
      operation: "execute",
      help: "pass tenantId",
      notes: ["n"],
    });

    expect(error.help).toBe("pass tenantId");
    expect(error.notes).toEqual(["n"]);
    expect(error.operation).toBe("execute");
  });
});

describe("the mode", () => {
  it.each([
    [{ AGBOSS_BACKTRACE: "0" }, BacktraceMode.Off],
    [{ AGBOSS_BACKTRACE: "1" }, BacktraceMode.Short],
    [{ AGBOSS_BACKTRACE: "full" }, BacktraceMode.Full],
    [{ RUST_BACKTRACE: "full" }, BacktraceMode.Full],
    [{ AGBOSS_BACKTRACE: "0", RUST_BACKTRACE: "full" }, BacktraceMode.Off],
    [{ AGBOSS_BACKTRACE: "nonsense", NODE_ENV: "production" }, BacktraceMode.Off],
    [{ NODE_ENV: "production" }, BacktraceMode.Off],
    [{}, BacktraceMode.Short],
  ])("%j is %s", (env, mode) => {
    expect(backtraceModeOf(env)).toBe(mode);
  });
});

describe("the Span trace", () => {
  it("is kept from where the error was made, across an await", async () => {
    const error = await inTestFrame(async () => {
      await Promise.resolve();
      return new SampleError("inside a step");
    });

    const text = error.format({ backtrace: BacktraceMode.Off, cwd: CWD });

    expect(error.spanTrace.map((frame) => frame.name)).toEqual([
      expect.stringMatching(/^agboss::[a-z-]+::run$/u),
      "agboss::workflow::run",
    ]);
    expect(text).toContain("\nSpan trace:\n   0: agboss::");
    expect(text).toMatch(/agboss::workflow::run workflow="[^"]+" version="[^"]+"/u);
  });

  it("is empty for an error made outside an execution", () => {
    const error = thrownByUser();

    expect(error.spanTrace).toEqual([]);
    expect(error.format({ backtrace: BacktraceMode.Off, cwd: CWD })).not.toContain("Span trace");
  });
});
