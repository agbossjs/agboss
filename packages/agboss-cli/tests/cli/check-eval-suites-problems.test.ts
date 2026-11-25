/** #1413 M3: `agboss check` lists a prompt or default-router error of an eval suite as a problem, not a crash. */
import { ConfigError } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { problemsOf } from "../../src/cli/check-eval-suites.js";

describe("problemsOf", () => {
  it("lists ConfigError.Prompt and ConfigError.NoDefaultRouter", () => {
    const router = new ConfigError.NoDefaultRouter({
      message: "[workflow.router] no default router",
    });
    const prompt = new ConfigError.Prompt({ problems: ["a placeholder is missing"] });

    expect(problemsOf("s.ts", router)).toHaveLength(1);
    expect(problemsOf("s.ts", prompt)).toHaveLength(1);
  });

  it("still rethrows an error that is no config problem", () => {
    expect(() => problemsOf("s.ts", new Error("bug"))).toThrow("bug");
  });
});
