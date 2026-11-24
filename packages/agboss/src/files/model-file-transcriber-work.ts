import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { recordUsage } from "../finops/usage.js";
import type { ModelBinding } from "../llm/registry.js";
import { contentOf, type ModelBlobPart } from "../models/content.js";
import type { FileContent } from "./file-bytes.js";
import type { TranscribeOptions, TranscriptionResult } from "./file-transcriber.js";
import { chargedCall, reportToFrame } from "../finops/charged-call.js";

/** What the built-in transcriber's model is told (#899 §6). */
export const TRANSCRIBER_SYSTEM = [
  "You transcribe a file for a reader who cannot see it.",
  "Transcribe its text verbatim, in reading order; describe any content that is not text (a photo, a chart, a stamp) in one short line each.",
  "Reply with the transcription only.",
].join(" ");

/** The file as the one part its model reads: an image, a PDF, an audio or a video. */
function partOf(file: FileContent): ModelBlobPart {
  const data = Buffer.from(file.bytes).toString("base64");
  if (file.mediaType.startsWith("image/"))
    return { kind: "image", mediaType: file.mediaType, data };
  if (file.mediaType.startsWith("audio/"))
    return { kind: "audio", mediaType: file.mediaType, data };
  if (file.mediaType.startsWith("video/"))
    return { kind: "video", mediaType: file.mediaType, data };
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
  const messages = [
    new SystemMessage(TRANSCRIBER_SYSTEM),
    new HumanMessage({ content: contentOf("Transcribe this file.", [partOf(file)]) }),
  ];
  const spec = {
    caller: "files:transcriber",
    settings: binding.settings,
    sent: messages,
    sink: reportToFrame,
  };
  const response = await chargedCall(spec, (callbacks) =>
    binding.model.invoke(messages, { signal: options.signal, callbacks }),
  );
  return {
    text: response.text,
    usage: recordUsage("files:transcriber", binding.settings, response),
  };
}
