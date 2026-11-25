/** #1413 M4: only the lookup's own miss means "no such tool"; any other component error is a real failure. */
import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { UnknownToolError, knows, toolLookup } from "../../src/app/parts.js";
import { treeToolsOf } from "../../src/app/child-deps.js";

describe("tool lookup", () => {
  it("a miss is an UnknownToolError, a ConfigError.Component", () => {
    const lookup = toolLookup([]);
    expect(() => lookup("x")).toThrow(UnknownToolError);
    expect(() => lookup("x")).toThrow(ConfigError.Component);
    expect(knows(lookup, "x")).toBe(false);
  });

  it("another ConfigError.Component from the lookup is thrown, not read as a miss", () => {
    const broken = (): never => {
      throw new ConfigError.Component({ message: "the container has no such binding" });
    };

    expect(() => knows(broken, "x")).toThrow("no such binding");
    const deps = { graph: { type: Object, nodes: new Map() }, tools: broken } as never;
    expect(() => treeToolsOf(deps)("x")).toThrow("no such binding");
  });
});
