/**
 * #1269 (files-pii mutation shard): the built-in redactor has no model of its own.
 */
import { describe, expect, it } from "vitest";
import { ModelImageRedactor } from "../../src/files/file-redactor.js";

describe("the built-in image redactor", () => {
  it("redacts on its agent's model: calling it with no model is refused, with the way to call it", async () => {
    const error: unknown = await new ModelImageRedactor().redact().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe(
      "ModelImageRedactor redacts on its agent's model: use redactWith",
    );
  });
});
