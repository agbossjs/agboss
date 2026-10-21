/**
 * AC3 (#87): these mistakes are compile errors. `make check` runs `tsc`; an `@ts-expect-error` whose
 * line compiles would itself fail the build — so every line below must stay an error.
 */
import { describe, expect, it } from "vitest";
import { Agent, InjectionToken, Tool, type ToolHandler } from "../../src/index.js";
import { Text } from "../../src/dto/index.js";
import { testConfig } from "../helpers.js";
import type { FilesServer } from "./fixture/components.js";

class Judge {
  readonly judge = true;
}
const SEARCH = new InjectionToken<{ boards: string[] }>("SEARCH");
class Query {
  @Text()
  q!: string;
}

class Answer {
  @Text()
  text!: string;
}
const In = Query;
const Out = Answer;

@Tool({ name: "ok-tool", description: "d", input: In, output: Out, deps: [Judge, SEARCH] })
class Ok implements ToolHandler<Query, Answer> {
  constructor(
    readonly judge: Judge,
    readonly search: { boards: string[] },
  ) {}
  run(): Promise<Answer> {
    return Promise.resolve({ text: "" });
  }
}

// @ts-expect-error — deps in the wrong order
@Tool({ name: "swapped-tool", description: "d", input: In, output: Out, deps: [SEARCH, Judge] })
class Swapped implements ToolHandler<Query, Answer> {
  constructor(
    readonly judge: Judge,
    readonly search: { boards: string[] },
  ) {}
  run(): Promise<Answer> {
    return Promise.resolve({ text: "" });
  }
}

// @ts-expect-error — a dependency missing from deps
@Tool({ name: "missing-tool", description: "d", input: In, output: Out, deps: [Judge] })
class Missing implements ToolHandler<Query, Answer> {
  constructor(
    readonly judge: Judge,
    readonly search: { boards: string[] },
  ) {}
  run(): Promise<Answer> {
    return Promise.resolve({ text: "" });
  }
}

// @ts-expect-error — run returns what the output DTO does not allow
@Tool({ name: "wrong-output-tool", description: "d", input: In, output: Out })
class WrongOutput {
  run(): Promise<number> {
    return Promise.resolve(1);
  }
}

/** Type-checked, never run: at runtime the missing name would be a ReferenceError. */
function usesMissing(): unknown {
  @Agent({
    name: "a",
    description: "d",
    model: "m",
    price: testConfig.agents.alpha.price,
    // @ts-expect-error — a component that is not imported / does not exist
    tools: [NotImported],
    prompt: "./x.md",
  })
  class UsesMissing {}
  return UsesMissing;
}

/** Type-checked, never run: the server's tools and their arguments are checked by the compiler (#109). */
function wrongServerCall(files: FilesServer): unknown {
  // @ts-expect-error — the server declares no tool "write"
  void files.call("write", { path: "x" });
  // @ts-expect-error — "read" takes a FileRead: { path }
  return files.call("read", { file: "x" });
}

describe("components — compile-time checks", () => {
  it("AC3: the file above type-checks only because each mistake is a compile error", () => {
    expect([Ok, Swapped, Missing, WrongOutput, usesMissing, wrongServerCall]).toHaveLength(6);
  });
});
