/**
 * #1321d: an id the application's `IdGenerator` mints is refused when it holds the child
 * separator, as an id a caller picks is: `ExecutionError.InvalidMintedId` naming the rule, never the id.
 */
import { ExecutionError } from "../../src/core/error-families/run-errors.js";
import { describe, expect, it } from "vitest";
import { KeyTextRule } from "../../src/errors.js";
import { CheckedIdGenerator, IdGenerator } from "../../src/infrastructure/clock.js";

class EvilIds extends IdGenerator {
  newThreadId(): string {
    return "tenant/child/x-evil";
  }

  newExecutionId(): string {
    return "root/child/x-evil";
  }
}

describe("#1321d: a minted id never holds the child separator", () => {
  const ids = new CheckedIdGenerator(new EvilIds());

  it.each([
    ["newThreadId", () => ids.newThreadId()],
    ["newExecutionId", () => ids.newExecutionId()],
  ] as const)("%s is refused, the rule named and the id not", (method, mint) => {
    let thrown: unknown;
    try {
      mint();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ExecutionError.InvalidMintedId);
    expect(thrown).toMatchObject({ method, rule: KeyTextRule.ReservedSeparator });
    expect((thrown as Error).message).not.toContain("x-evil");
  });
});
