import type { ModelAudioPart } from "./content.js";
import { ModelProviderInputError } from "./transport/input-error.js";
import type { WireContentPart } from "./wire.js";

/** The audio formats the wire names, by media type (#899 §2): any other is refused. */
const AUDIO_FORMATS: Readonly<Record<string, string>> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
};

export function audioWirePartOf(part: ModelAudioPart): WireContentPart {
  const format = Object.hasOwn(AUDIO_FORMATS, part.mediaType)
    ? AUDIO_FORMATS[part.mediaType]
    : undefined;
  if (format === undefined)
    throw new ModelProviderInputError({ kind: "audio", mediaType: part.mediaType });
  return { type: "input_audio", input_audio: { data: part.data, format } };
}
