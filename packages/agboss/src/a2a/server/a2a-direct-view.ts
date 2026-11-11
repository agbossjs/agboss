import { Role, type Message } from "@a2a-js/sdk";
import type { A2ADirectMessageRecord } from "../../infrastructure/a2a-direct-message.repository.js";
import { encodeRunReport } from "../../mesh/mesh-report.js";
import { A2A_MESH_EXTENSION, A2A_SKILLS_EXTENSION } from "../a2a-extension-uris.js";
import { finishPartsOf, type TaskViewParts } from "./a2a-task-view.js";

/**
 * A completed direct reply as A2A v1.0 shows it (#860, design §4.1.8): one agent `Message` — no
 * task id —, its parts the finish's output as a task's artifact carries them (text, data, file parts,
 * #859), its metadata the finish's name and, for a trusted caller, the run report the application
 * signs over what the run spent, bound to the message's `bodyHash` and dated by the reply. Built
 * from the kept row alone, so every resend gets the same message.
 */

/** The id of a direct reply: its attempt's, so a resend gets the same message. */
export const replyMessageIdOf = (attemptId: string): string => `${attemptId}:reply`;

/** The run report of a trusted caller's completed reply; `undefined` for any other. */
function reportOf(
  message: A2ADirectMessageRecord,
  mesh: TaskViewParts["mesh"],
): Record<string, unknown> {
  const key = mesh.keys.signingKey;
  const { reply, meshBodyHash, completedAt } = message;
  if (reply === undefined || completedAt === undefined) return {};
  if (meshBodyHash === undefined || key === undefined) return {};
  const facts = {
    issuer: mesh.application,
    executionId: message.attemptId,
    spentUsd: reply.spentUsd,
    bodyHash: meshBodyHash,
    issuedAt: completedAt,
  };
  return { [A2A_MESH_EXTENSION]: { report: encodeRunReport(facts, key) } };
}

/** A completed direct reply as the wire carries it. */
export async function wireReplyOf(
  message: A2ADirectMessageRecord,
  parts: TaskViewParts,
): Promise<Message> {
  const { reply } = message;
  // Stryker disable next-line ConditionalExpression: the invariant, never false while it holds
  if (reply === undefined) throw new Error("a direct message is shown once it has a reply");
  const skill = parts.skills.find((served) => served.id === message.skill);
  const owner = { tenantId: message.tenantId, ownerId: message.attemptId, ...reply };
  const shown = await finishPartsOf(owner, skill, parts.files.store);
  const missing = shown.missingFiles === 0 ? {} : { missingFiles: shown.missingFiles };
  return {
    messageId: replyMessageIdOf(message.attemptId),
    contextId: message.contextId,
    taskId: "",
    role: Role.ROLE_AGENT,
    parts: [...shown.parts],
    metadata: {
      [A2A_SKILLS_EXTENSION]: { finish: reply.finish, ...missing },
      ...reportOf(message, parts.mesh),
    },
    extensions: [],
    referenceTaskIds: [],
  };
}
