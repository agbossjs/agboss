import { createHash } from "node:crypto";
import { expect } from "vitest";
import { replyWith, testWith } from "@agboss/core/testing";
import { FlowPatternsApplication } from "../../../../src/flow-patterns.application.js";
import { AudioNoteAgent } from "../../../../src/files/agents/audio-note/audio-note.agent.js";
import { AudioNoteResultWorkflowFinish } from "../../../../src/files/workflows/audio-note/audio-note-result.workflow-finish.js";
import { AudioNoteWorkflowStart } from "../../../../src/files/workflows/audio-note/audio-note.workflow-start.js";

/** #899: a voice note reaches the model as an audio part. */

const test = testWith(FlowPatternsApplication);

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const inline = (bytes: Uint8Array, mediaType: string, filename: string) => ({
  mediaType,
  filename,
  inline: Buffer.from(bytes).toString("base64"),
  sha256: sha256Of(bytes),
  sizeBytes: bytes.byteLength,
});

const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.from("voice-note-bytes")]);

test("the voice note is an audio part", async ({ app, mockModel }) => {
  const agent = mockModel(AudioNoteAgent).thenReturn(replyWith("A reminder to call back."));

  const result = await app.execute(AudioNoteWorkflowStart, {
    note: inline(MP3, "audio/mpeg", "note.mp3"),
  });

  const [request] = agent.requests;
  expect(request?.kind === "chat" ? request.parts : []).toEqual([
    expect.objectContaining({ kind: "audio", mediaType: "audio/mpeg", sha256: sha256Of(MP3) }),
  ]);
  expect(result).toFinishWith(AudioNoteResultWorkflowFinish, { text: "A reminder to call back." });
});
