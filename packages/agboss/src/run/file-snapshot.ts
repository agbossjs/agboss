import type { Class } from "../components/injection.js";

/**
 * The application's own file transcriber and redactor (#899, #1269) in a workflow's `configHash`: by
 * class name, only where the application lists one, so every other workflow keeps its hash. Another
 * redactor reads, keeps or hides another thing in the same file: a run paused under one is not resumed
 * blindly under the other (the resume guard, #201).
 */
export interface FileProcessorSource {
  readonly ownFileRedactor?: Class | undefined;
  readonly ownFileTranscriber?: Class | undefined;
}

export function fileProcessorSnapshot(source: FileProcessorSource): object {
  const { ownFileRedactor: redactor, ownFileTranscriber: transcriber } = source;
  if (redactor === undefined && transcriber === undefined) return {};
  return {
    fileProcessors: {
      ...(redactor === undefined ? {} : { redactor: redactor.name }),
      ...(transcriber === undefined ? {} : { transcriber: transcriber.name }),
    },
  };
}
