/** #1269: the built-in transcriber: what its model is told, the part its file is, its refusal to transcribe on its own. */
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { ModelFileTranscriber } from "../../src/files/file-transcriber.js";
import { TRANSCRIBER_SYSTEM, transcribed } from "../../src/files/model-file-transcriber-work.js";
import type { ModelBinding } from "../../src/llm/registry.js";
import { sha256Of } from "./reader.factory.js";

interface Call {
  readonly messages: readonly BaseMessage[];
  readonly options: unknown;
}

/** A model that answers "SEEN" and keeps what it was asked. */
function binding(calls: Call[]): ModelBinding {
  const model = {
    invoke: (messages: readonly BaseMessage[], options: unknown): Promise<AIMessage> => {
      calls.push({ messages, options });
      return Promise.resolve(
        new AIMessage({
          content: "SEEN",
          usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }),
      );
    },
  };
  return {
    model,
    settings: { model: "vision-1", price: { inputPerMTok: 1, outputPerMTok: 2 } },
  } as never;
}

const fileOf = (mediaType: string, filename?: string) => {
  const bytes = Buffer.from("ABC");
  return {
    mediaType,
    bytes,
    sha256: sha256Of(bytes),
    ...(filename === undefined ? {} : { filename }),
  };
};
const OPTIONS = { signal: new AbortController().signal, tenantId: "t" };

describe("#1269: transcribed", () => {
  it("tells the model what to do, in one text", () => {
    expect(TRANSCRIBER_SYSTEM).toBe(
      "You transcribe a file for a reader who cannot see it. Transcribe its text verbatim, in reading order; describe any content that is not text (a photo, a chart, a stamp) in one short line each. Reply with the transcription only.",
    );
  });

  it("asks with the system text and the file; passes the signal; bills files:transcriber", async () => {
    const calls: Call[] = [];
    const result = await transcribed(binding(calls), fileOf("image/png"), OPTIONS);

    expect(result.text).toBe("SEEN");
    expect(result.usage?.caller).toBe("files:transcriber");
    expect(result.usage?.model).toBe("vision-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toEqual({ signal: OPTIONS.signal });
    expect(calls[0]?.messages[0]?.content).toBe(TRANSCRIBER_SYSTEM);
    expect(calls[0]?.messages[1]?.content).toEqual([
      { type: "text", text: "Transcribe this file." },
      { type: "agboss_part", kind: "image", mediaType: "image/png", data: "QUJD" },
    ]);
  });

  it.each([
    ["image/webp", "image"],
    ["audio/mpeg", "audio"],
    ["video/mp4", "video"],
  ])("%s is a %s part, with no filename", async (mediaType, kind) => {
    const calls: Call[] = [];
    await transcribed(binding(calls), fileOf(mediaType, "name.bin"), OPTIONS);

    expect(calls[0]?.messages[1]?.content).toEqual([
      { type: "text", text: "Transcribe this file." },
      { type: "agboss_part", kind, mediaType, data: "QUJD" },
    ]);
  });

  it("a PDF is a file part with its filename; without one, none", async () => {
    const calls: Call[] = [];
    await transcribed(binding(calls), fileOf("application/pdf", "a.pdf"), OPTIONS);
    await transcribed(binding(calls), fileOf("application/pdf"), OPTIONS);

    expect(calls[0]?.messages[1]?.content).toEqual([
      { type: "text", text: "Transcribe this file." },
      {
        type: "agboss_part",
        kind: "file",
        mediaType: "application/pdf",
        filename: "a.pdf",
        data: "QUJD",
      },
    ]);
    expect(calls[1]?.messages[1]?.content).toStrictEqual([
      { type: "text", text: "Transcribe this file." },
      { type: "agboss_part", kind: "file", mediaType: "application/pdf", data: "QUJD" },
    ]);
  });

  it("a media type that only contains a prefix is a file, not that kind", async () => {
    const calls: Call[] = [];
    await transcribed(binding(calls), fileOf("application/x-audio/"), OPTIONS);

    expect(calls[0]?.messages[1]?.content).toEqual([
      { type: "text", text: "Transcribe this file." },
      { type: "agboss_part", kind: "file", mediaType: "application/x-audio/", data: "QUJD" },
    ]);
  });
});

describe("#1269: ModelFileTranscriber.transcribe", () => {
  it("rejects: the built-in transcribes on its agent's model", async () => {
    await expect(new ModelFileTranscriber().transcribe()).rejects.toThrow(
      new TypeError("ModelFileTranscriber transcribes on its agent's model: use transcribeWith"),
    );
  });
});
