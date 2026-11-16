/**
 * #899 §5: PII never sees a file's bytes, and only they are exempt — every other block, text or
 * not, is masked as before.
 */
import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { maskedMessageOf } from "../../src/pii/message-mask.js";
import { blockOfPart } from "../../src/models/content.js";

const mask = (text: string): Promise<string> =>
  Promise.resolve(text.replaceAll("secret", "<kind>"));

describe("message masking and file parts", () => {
  it("a non-text, non-file block that carries a PII string is masked", async () => {
    const block = { type: "image_url", image_url: { url: "https://x.example/secret.png" } };

    const masked = await maskedMessageOf(new HumanMessage({ content: [block] }), mask);

    expect(JSON.stringify(masked.content)).not.toContain("secret");
    expect(JSON.stringify(masked.content)).toContain("<kind>");
  });

  it("a file part's bytes are never handed to the mask", async () => {
    const seen: string[] = [];
    const part = blockOfPart({ kind: "file", mediaType: "application/pdf", data: "c2VjcmV0" });

    const masked = await maskedMessageOf(
      new HumanMessage({ content: [part, { type: "text", text: "a secret" }] }),
      (text: string) => {
        seen.push(text);
        return mask(text);
      },
    );

    expect(seen).toEqual(["a secret"]);
    expect(masked.content).toEqual([part, { type: "text", text: "a <kind>" }]);
  });
});
