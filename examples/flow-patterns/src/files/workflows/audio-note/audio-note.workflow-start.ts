import { WorkflowStart } from "@agboss/core";
import { AudioNoteRequestDto } from "../../dto/audio-note-request.dto.js";

/** The files of one audio-note request. */
@WorkflowStart({
  name: "audio-note-workflow-start",
  description: "The files of one audio-note request",
  input: AudioNoteRequestDto,
})
export class AudioNoteWorkflowStart {}
