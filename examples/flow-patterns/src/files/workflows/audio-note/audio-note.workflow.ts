import { Workflow, onStart } from "@agboss/core";
import { AudioNoteAgent } from "../../agents/audio-note/audio-note.agent.js";
import { AudioNoteResultWorkflowFinish } from "./audio-note-result.workflow-finish.js";
import { AudioNoteFilePolicy } from "./audio-note.file-policy.js";
import { AudioNoteWorkflowStart } from "./audio-note.workflow-start.js";

/** The files of a audio-note request, read by one agent. */
@Workflow({
  name: "audio-note-workflow",
  version: "1.0.0",
  filePolicy: AudioNoteFilePolicy,
  flow: [
    onStart(AudioNoteWorkflowStart)
      .toAgent(AudioNoteAgent)
      .toFinish(AudioNoteResultWorkflowFinish),
  ],
})
export class AudioNoteWorkflow {}
