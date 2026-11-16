import { Workflow, start } from "@agboss/core";
import { AudioNoteAgent } from "../../agents/audio-note/audio-note.agent.js";
import { AudioNoteRequestDto } from "../../dto/audio-note-request.dto.js";
import { AudioNoteResultWorkflowFinish } from "./audio-note-result.workflow-finish.js";
import { AudioNoteWorkflowStart } from "./audio-note.workflow-start.js";

/** The files of a audio-note request, read by one agent. */
@Workflow({
  name: "audio-note-workflow",
  version: "1.0.0",
  flow: [
    start(AudioNoteWorkflowStart)
      .returns(AudioNoteRequestDto)
      .toAgent(AudioNoteAgent)
      .toFinish(AudioNoteResultWorkflowFinish),
  ],
})
export class AudioNoteWorkflow {}
