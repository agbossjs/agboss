import { channelRoleOf } from "../channels/channel-role.decorator.js";
import { channelUsesOf } from "../channels/discovery.js";
import { pauseTargetOf } from "../channels/pause-targets.js";
import type { FoldedConfig } from "../config/fold-config.js";
import { ProfileError, ProfileErrorReason } from "../config/profile-error.js";
import type { AssembledWorkflow } from "../workflow.js";

/** What the profiles name must exist once every workflow is assembled: a name nothing has is a typo. */

/** A name a pause target shelf holds is a target of that kind some workflow uses. */
export function checkPauseTargets(
  folded: FoldedConfig,
  assembled: readonly AssembledWorkflow[],
): void {
  const kinds = new Map<string, string>();
  for (const use of channelUsesOf(assembled.map((workflow) => workflow.graph.type))) {
    const role = channelRoleOf(use.channel);
    const kind = role === undefined ? undefined : pauseTargetOf(role.role)?.kind;
    if (role !== undefined && kind !== undefined) kinds.set(role.options.name, kind);
  }
  const shelves = [
    ["toolApprovals", "tool-approval", "@ToolApproval"],
    ["externalTasks", "external-task", "@ExternalTask"],
  ] as const;
  for (const [shelf, kind, decorator] of shelves) {
    const [lost] = Object.keys(folded[shelf]).filter((name) => kinds.get(name) !== kind);
    if (lost !== undefined)
      throw new ProfileError({
        reason: ProfileErrorReason.Unknown,
        message: `profile ${folded.profiles.join(",")}: ${shelf}.${lost}: no such ${decorator} used in the application — it has: ${
          [...kinds]
            .filter(([, one]) => one === kind)
            .map(([name]) => name)
            .join(", ") || "none"
        }`,
      });
  }
}

/** The memories a profile changes are memories some workflow of the application reads. */
export function checkMemories(folded: FoldedConfig, assembled: readonly AssembledWorkflow[]): void {
  const has = new Set(
    assembled.flatMap((workflow) =>
      (workflow.memories?.memories ?? []).map((memory) => memory.name),
    ),
  );
  const [lost] = Object.keys(folded.memories).filter((name) => !has.has(name));
  if (lost !== undefined)
    throw new ProfileError({
      reason: ProfileErrorReason.Unknown,
      message: `profile ${folded.profiles.join(",")}: memories.${lost}: no such memory in use in the application — it has: ${[...has].join(", ") || "none"}`,
    });
}
