/**
 * #899 §5: PII never sees a file's bytes, and only the file blocks are exempt (`agboss_part`, `image_url`, `file`, `input_audio`, `video_url`) — a text
 * block's text and every other kind of block's strings are masked as before.
 */
import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { maskedMessageOf } from "../../src/pii/message-mask.js";
import { blockOfPart } from "../../src/models/content.js";

const mask = (text: string): Promise<string> =>
  Promise.resolve(text.replaceAll("secret", "<kind>"));

describe("message masking and file blocks", () => {
  it("AC3: image_url, file, input_audio and video_url blocks are passed through untouched — their strings are never sent to a mask", async () => {
    const seen: string[] = [];
    const blocks = [
      { type: "image_url", image_url: { url: "data:image/png;base64,c2VjcmV0" } },
      {
        type: "file",
        file: { filename: "secret.pdf", file_data: "data:application/pdf;base64,c2VjcmV0" },
      },
      { type: "input_audio", input_audio: { data: "c2VjcmV0", format: "mp3" } },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,c2VjcmV0" } },
    ];

    const masked = await maskedMessageOf(
      new HumanMessage({ content: [...blocks, { type: "text", text: "a secret" }] }),
      (text: string) => {
        seen.push(text);
        return mask(text);
      },
    );

    expect(seen).toEqual(["a secret"]);
    expect(masked.content).toEqual([...blocks, { type: "text", text: "a <kind>" }]);
  });

  it("a block of another kind that carries a PII string is still masked", async () => {
    const block = { type: "reasoning", reasoning: "the secret is 4" };

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
