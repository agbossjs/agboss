/** #899 §9: a part is shown as `{ kind, mediaType, filename?, sizeBytes, sha256 }` in events, traces and cassettes. */
import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { redactedFilesIn, withoutInlineBytes } from "../../src/a2a/files/a2a-file-scrub.js";
import { blockOfPart, partMetaOf } from "../../src/models/content.js";
import { chatRequestOf } from "../../src/testing/vcr-chat-model.js";
import { NO_OBSERVABILITY_MASK } from "../../src/pii/observability-mask.js";
import { sha256Of } from "./reader.factory.js";

const BYTES = Buffer.from("%PDF-1.4 SECRET-PART-BYTES");
const part = {
  kind: "file",
  mediaType: "application/pdf",
  filename: "a.pdf",
  data: BYTES.toString("base64"),
} as const;
const message = (data = part.data) =>
  new HumanMessage({ content: [{ type: "text", text: "see" }, blockOfPart({ ...part, data })] });

describe("a file part as an event, a trace and a cassette show it", () => {
  it("partMetaOf names the part and its bytes by digest and size", () => {
    expect(partMetaOf(part)).toEqual({
      type: "agboss_part",
      kind: "file",
      mediaType: "application/pdf",
      filename: "a.pdf",
      sizeBytes: BYTES.byteLength,
      sha256: sha256Of(BYTES),
    });
  });

  it("an event's message (rawPayload) and a plain part carry no bytes", async () => {
    const shown = await NO_OBSERVABILITY_MASK.value({
      rawPayload: [message()],
      block: blockOfPart(part),
    });

    expect(JSON.stringify(redactedFilesIn([message()]))).not.toContain(part.data);
    expect(JSON.stringify(shown)).not.toContain(part.data);
    expect(JSON.stringify(withoutInlineBytes(blockOfPart(part)))).not.toContain(part.data);
    expect(JSON.stringify(shown)).toContain(sha256Of(BYTES));
  });

  it("a cassette's request hash covers a part by digest: the same file, the same request; another, another", () => {
    const hash = (m: HumanMessage) => chatRequestOf("m", [m], []);

    expect(hash(message())).toBe(hash(message()));
    expect(hash(message())).not.toBe(
      hash(message(Buffer.from("%PDF-1.4 other").toString("base64"))),
    );
  });
});
