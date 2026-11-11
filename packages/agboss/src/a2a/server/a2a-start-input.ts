import type { Message } from "@a2a-js/sdk";
import type { NewA2AFile } from "../../infrastructure/a2a-file.repository.js";
import { fileAdmissionOf } from "./a2a-file-admission.js";
import { filesOfMessage } from "./a2a-message-files.js";
import { inputOfMessage } from "./a2a-message-input.js";
import type { A2ARequestCaller, A2AServerParts } from "./a2a-server-parts.js";
import type { ServedSkill } from "./a2a-skills.js";

/**
 * A new message's start input under a task's id (#859): its files admitted for that task — fetched
 * once, checked, described inline or under the task in the store — then the input checked against
 * the start; the files the store keeps before the task is saved.
 */

/** A message's input for one task: the start's input and the files the store keeps first. */
export interface StartInput {
  readonly input: unknown;
  readonly toSave: readonly NewA2AFile[];
}

/** The input of a new message for one task id: its files admitted, then checked against the start. */
export function inputForOf(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  message: Message,
  skill: ServedSkill,
): (taskId: string) => Promise<StartInput> {
  const sent = { skill, messageId: message.messageId };
  const admission = fileAdmissionOf(parts, caller, sent, filesOfMessage(message, skill));
  return async (taskId) => {
    const { files, toSave } = await admission(taskId);
    return { input: inputOfMessage(message, skill, files), toSave };
  };
}

/** Keeps a task's input files before the task: a resend or a takeover reads the same bytes. */
export async function keptFiles(
  parts: A2AServerParts,
  files: readonly NewA2AFile[],
): Promise<void> {
  for (const file of files) await parts.files.store.save(file);
}
