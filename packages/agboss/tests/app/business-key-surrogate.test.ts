/**
 * A business key built in code (not from a checked input) with a lone surrogate — half of a pair,
 * as `text.slice(0, n)` leaves one: no store keeps it as it is (SQLite and PostgreSQL write UTF-8,
 * where it becomes U+FFFD, so two keys become one), and the provider's idempotency key cannot be
 * built from it (`encodeURIComponent` throws). It is refused like any other invalid business key,
 * before anything runs — never a `URIError` from the send, never another order's row.
 */
import { IdempotencyError } from "../../src/core/error-families/effect-errors.js";
import { describe, expect, it } from "vitest";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import { Action, ExecutionContext } from "../../src/index.js";
import { effectKeyOf } from "../../src/stores/index.js";
import { isThreadId } from "../../src/run/thread.js";
import { testAction } from "../../src/testing/index.js";

/** "order:🧾42" cut one code unit into the emoji, as a slice by length does. */
const CUT = "order:\u{1F9FE}42".slice(0, 7);

@Action({
  name: "cut-key-action",
  description: "Keys an effect by a business key cut in the middle of a character",
  input: { message: WorkflowStartTextDto },
  output: WorkflowStartTextDto,
  deps: [ExecutionContext],
})
class CutKeyAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(): Promise<WorkflowStartTextDto> {
    effectKeyOf(this.executionContext, "charge", { businessKey: CUT });
    return Promise.resolve({ text: "keyed" });
  }
}

describe("a business key with a lone surrogate", () => {
  it("is not a valid key or thread id; a whole pair is", () => {
    expect(isThreadId(CUT)).toBe(false);
    expect(isThreadId("t\udc00")).toBe(false);
    expect(isThreadId("order:\u{1F9FE}42")).toBe(true);
  });

  it("effectKeyOf refuses it with IdempotencyError.InvalidKey, the key not in the message", async () => {
    const run = testAction(CutKeyAction);

    const error: unknown = await run({ message: { value: { text: "x" } } }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(IdempotencyError.InvalidKey);
    expect((error as Error).message).not.toContain("order:");
  });
});
