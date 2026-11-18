import { inputKindOfMediaType, type ModelInputKind } from "../models/content.js";
import type { InputNeed } from "../models/uses.js";
import type { ResolvedModelFiles } from "./file-settings.js";
import { FileView } from "./model-files.js";

/**
 * What the files of an agent need of the models that read them (#899 §4): the media type of a file
 * and the view it comes in say the kind of input — any type in the transcription and a text format in
 * any view are `text`, an image `image`, a PDF `file`.
 */

/** Whether a media type is a text format: it goes into the message as text. */
export const isTextFormat = (mediaType: string): boolean =>
  mediaType.startsWith("text/") || mediaType === "application/json";

/** Whether a media type has a form in a model message: a text, an image, a PDF, an audio, a video. */
export const hasModelForm = (mediaType: string): boolean =>
  isTextFormat(mediaType) ||
  mediaType.startsWith("image/") ||
  mediaType.startsWith("audio/") ||
  mediaType.startsWith("video/") ||
  mediaType === "application/pdf";

/** The input kind a file of `mediaType` is for the model that reads it in `view`. */
export function kindOfView(mediaType: string, view: FileView): ModelInputKind {
  if (view === FileView.Transcription || isTextFormat(mediaType)) return "text";
  return inputKindOfMediaType(mediaType);
}

/** Every kind the agent's model reads: its types in its views (`Redacted` reads like `Original`). */
export function needsOf(files: ResolvedModelFiles): readonly InputNeed[] {
  const seen = new Set<string>();
  return files.views.flatMap((view) =>
    files.allowedMediaTypes.filter(hasModelForm).flatMap((mediaType) => {
      const kind = kindOfView(mediaType, view);
      // a transcription reads every type as one text: one need of its kind; a raw type is its own
      const key = view === FileView.Transcription ? kind : `${kind}:${mediaType}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ kind, mediaType, view }];
    }),
  );
}

/** What the built-in transcriber's model reads: the raw files of the types it transcribes. */
export function transcriberNeedsOf(files: ResolvedModelFiles): readonly InputNeed[] {
  const kinds = new Map<ModelInputKind, InputNeed>();
  for (const mediaType of files.allowedMediaTypes.filter(hasModelForm)) {
    const kind = inputKindOfMediaType(mediaType);
    if (!isTextFormat(mediaType) && !kinds.has(kind))
      kinds.set(kind, { kind, mediaType, view: FileView.Transcription });
  }
  return [...kinds.values()];
}

/** The media types of a defaulted set that the model takes (`inputs`): the rest wait for a model that takes them. */
export function narrowedTypesOf(
  files: ResolvedModelFiles,
  inputs: readonly ModelInputKind[],
): string[] {
  return files.allowedMediaTypes.filter((mediaType) =>
    files.views.every(
      (view) => inputs.includes(kindOfView(mediaType, view)) || !hasModelForm(mediaType),
    ),
  );
}
