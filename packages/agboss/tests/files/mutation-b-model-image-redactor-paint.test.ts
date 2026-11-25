/**
 * #1269 (files-pii mutation shard): when the copy cannot be painted, the redaction fails closed.
 */
import { StepError } from "../../src/core/error-families/step-errors.js";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it, vi } from "vitest";
import { sha256Of } from "../../src/files/file-bytes.js";
import { redacted } from "../../src/files/model-image-redactor-work.js";
import { PiiKind } from "../../src/pii/kinds.js";
import { seconds } from "../../src/units/index.js";
import { usd } from "../../src/units/index.js";

const { broken } = vi.hoisted(() => ({ broken: new Error("vips: out of memory") }));

/** sharp as it is, except painting — the read of the raw pixels — cannot be done. */
vi.mock("sharp", async (importOriginal) => {
  const actual = await importOriginal<{ default: (...args: unknown[]) => object }>();
  const wrapped = (input: unknown, options?: unknown) => {
    const real = actual.default(input, options);
    return Object.assign(real, {
      raw: () => {
        throw broken;
      },
    });
  };
  return { ...actual, default: wrapped };
});

const settings = {
  model: "test/redactor",
  temperature: 0,
  maxTokens: 100,
  thinking: "default" as const,
  cache: true,
  timeout: seconds(1),
  maxRetries: 0,
  price: { inputPerMillion: usd(1), outputPerMillion: usd(1) },
};

describe("the copy cannot be painted", () => {
  it("fails closed with its reason and cause, never the unredacted file", async () => {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const model = new FakeListChatModel({
      responses: ['{"regions":[{"target":"card-number","x":0.1,"y":0.1,"w":0.2,"h":0.2}]}'],
    });

    const error: unknown = await redacted(
      { model, settings },
      "reader-agent",
      { mediaType: "image/png", bytes, sha256: sha256Of(bytes) },
      {
        targets: [PiiKind.CardNumber],
        values: [],
        signal: new AbortController().signal,
        tenantId: "t",
      },
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(StepError.FileMaskingFailed);
    const failed = error as StepError.FileMaskingFailed;
    expect(failed.reason).toBe("the redacted copy cannot be made");
    expect(failed.agent).toBe("reader-agent");
    expect(failed.cause).toBe(broken);
  });
});
