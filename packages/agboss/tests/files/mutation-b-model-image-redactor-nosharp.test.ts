/**
 * #1269 (files-pii mutation shard): without the optional peer dependency `sharp` the built-in redactor
 * fails closed, and says what to install.
 */
import { StepError } from "../../src/core/error-families/step-errors.js";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it, vi } from "vitest";
import { sha256Of } from "../../src/files/file-bytes.js";
import { redacted } from "../../src/files/model-image-redactor-work.js";
import { PiiKind } from "../../src/pii/kinds.js";
import { seconds } from "../../src/units/index.js";
import { usd } from "../../src/units/index.js";

vi.mock("sharp", () => {
  throw new Error("Cannot find module 'sharp'");
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

describe("sharp is not installed", () => {
  it("the redaction fails closed with the way to install it, before any model is asked", async () => {
    const model = new FakeListChatModel({ responses: ['{"regions":[]}'] });
    const bytes = Buffer.from("png-bytes");

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
    expect(failed.reason).toBe(
      "the built-in redactor needs the optional peer dependency sharp (npm i sharp)",
    );
    expect(failed.agent).toBe("reader-agent");
    expect(failed.cause).toBeInstanceOf(Error);
  });
});
