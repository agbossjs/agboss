import { Agent, FileView, ModelFiles } from "@agboss/core";
import { megabytes } from "@agboss/core/units";
import { AudioNoteRequestDto } from "../../dto/audio-note-request.dto.js";

/** Listens to a voice note: an audio part, to a model that takes audio. */
@Agent({
  name: "audio-note-agent",
  description: "Summarises a voice note",
  prompt: "Summarise the voice note in one sentence.",
  model: "google/gemini-2.5-flash",
  input: { request: AudioNoteRequestDto },
  files: ModelFiles.of({
    views: [FileView.Original],
    allowedMediaTypes: ["audio/mpeg", "audio/mp4"],
    maxFileSize: megabytes(5),
    maxTotalFileSize: megabytes(5),
  }),
})
export class AudioNoteAgent {}
