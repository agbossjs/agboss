import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { recordUsage } from "../finops/usage.js";
import type { ModelBinding } from "../llm/registry.js";
import { contentOf, type ModelFilePart, type ModelImagePart } from "../models/content.js";
import type { FileContent } from "./file-bytes.js";
import type { TranscribeOptions, TranscriptionResult } from "./file-transcriber.js";

/** What the built-in transcriber's model is told (#899 §6). */
export const TRANSCRIBER_SYSTEM = [
  "You transcribe a file for a reader who cannot see it.",
  "Transcribe its text verbatim, in reading order; describe any content that is not text (a photo, a chart, a stamp) in one short line each.",
  "Reply with the transcription only.",
].join(" ");

/** The file as the one part its model reads: an image, or a PDF. */
function partOf(file: FileContent): ModelImagePart | ModelFilePart {
  const data = Buffer.from(file.bytes).toString("base64");
  if (file.mediaType.startsWith("image/"))
    return { kind: "image", mediaType: file.mediaType, data };
  return {
    kind: "file",
    mediaType: file.mediaType,
    ...(file.filename === undefined ? {} : { filename: file.filename }),
    data,
  };
}

/** One call to the transcription model: the text it gave and the call's spend under `files:transcriber`. */
export async function transcribed(
  binding: ModelBinding,
  file: FileContent,
  options: TranscribeOptions,
): Promise<TranscriptionResult> {
  const response = await binding.model.invoke(
    [
      new SystemMessage(TRANSCRIBER_SYSTEM),
      new HumanMessage({ content: contentOf("Transcribe this file.", [partOf(file)]) }),
    ],
    { signal: options.signal },
  );
  return {
    text: response.text,
    usage: recordUsage("files:transcriber", binding.settings, response),
  };
}
